# MeetingCast - 即時會議翻譯助手

中／英／日／越任一語言會議即時轉寫 + 並行翻譯到兩個可配置譯文槽位視窗（各自選目標語言）供外籍同仁閱讀。指標優先序：**準確性 > 速度 > 成本**。源語言可選 zh/en/ja/vi；目標語言可選 zh/en/ja/vi/km（km 柬埔寨文為 target-only，Whisper 對 Khmer 辨識品質不堪用，registry `source_capable: false` 把它從源語言選單隱藏）；單場單向，不同時處理對方發言。

目前 ship 0.1.14 ad-hoc 簽章 dmg、可分發 fresh Mac，整套 entitlements / cwd / mic / SSL / prewarm 坑都修過。完整資料流 / 訊息協定 / crash watchdog 設計見 `docs/ARCHITECTURE.md`。

## 關鍵架構決策（不要重新討論）

- **STT 引擎用 mlx-whisper**（不是 faster-whisper）— ctranslate2 在 macOS 沒 Metal，CPU 4.3s vs mlx Metal 0.9s
- **雙 backend**：`MLXWhisperSTT`（local 預設）+ `OpenAIRealtimeWhisperSTT`（openai cloud），同一 `Transcript` stream 介面，UI 可切。Deepgram backend 已於 0.1.20 後移除
- **語言登錄表是單一事實來源**：`shared/languages.json` 一份，Rust `include_str!` + Python 讀 + TS import。source 可選 zh/en/ja/vi，target 可選 zh/en/ja/vi/km；`source_capable: false` 標記 target-only 語言（km），script_profile / prompt 名 / carrier / empty_state 全收斂於此。加語言＝補一筆，見 `docs/ADD_LANGUAGE.md`（UI 元件 registry-driven，零改動）
- **兩個可配置槽位視窗**：視窗 label 固定 `t1` / `t2`（不再是 en/vi），顯示語言由 config `[language].target_slots[slotIndex]` runtime 解析；事件仍帶語言後綴 `translation:chunk:{lang}`；slot 設 `""` 即關閉
- **翻譯在 Rust 不在 sidecar**：Anthropic API 由 `src-tauri/src/translator.rs` 處理，sidecar 只負責 STT
- **Sidecar 訊息協定**：line-delimited JSON over stdio。命令：`start` / `stop` / `shutdown` / `list_devices`；事件：`ready` / `started` / `transcript` / `stopped` / `error` / `warning` / `prewarm` / `model_loading` / `model_ready` / `devices`
- **翻譯 chunk 帶 utterance id**：避免並行翻譯時 chunk 在 UI 交錯
- **dev sidecar binary 陷阱**：`pnpm tauri dev` 會把 `binaries/stt_engine-<triple>` copy 到 `target/debug/`，sidecar.rs 優先吃這個 stale binary。測 Python 改動前先 `mv src-tauri/target/debug/stt_engine src-tauri/target/debug/stt_engine.bak`
- **色票統一**：`App.css` 的 `@theme paper-* / danger-* / warn-* / recording`，元件不寫 hex

## 常用指令

```bash
# Phase 1 CLI（cwd: prototype/）
.venv/bin/python cli.py --mic --backend local --translate
.venv/bin/python cli.py --vad-demo samples/weather_90s.wav --translate
.venv/bin/python cli.py --text "中文句子"

# Tauri 桌面版
pnpm tauri dev
./scripts/build-sidecar.sh         # PyInstaller，~5 min，Python 改才需要
pnpm bundle:mac                    # .app + 重簽 sidecar + .dmg，~1 min
cd src-tauri && cargo test
```

## 包版 SOP（macOS .dmg）

**完整查表 + 9 個版本踩坑歷史 + 診斷招式都在 memory `project_macos_signing.md`，ship 前必讀。**

每次都要：

1. 三處版本同步 — `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`
2. `cd src-tauri && cargo update -p meetingcast --offline`
3. `./scripts/build-sidecar.sh`（Python / requirements.txt 改過才需要）
4. `pnpm bundle:mac`（不要只跑 `pnpm tauri build`；後者會覆蓋 sidecar identifier）
5. **驗 `Entitlements.plist` 含 5 個 key**（少一個 fresh Mac 必炸）：
   - `com.apple.security.device.audio-input`
   - `com.apple.security.cs.disable-library-validation`
   - `com.apple.security.cs.allow-unsigned-executable-memory`
   - `com.apple.security.cs.allow-jit`
   - `com.apple.security.cs.allow-dyld-environment-variables`
6. **驗兩個 binary 都簽好**（dev 機 `tccutil reset` 也驗不到 entitlements 缺漏）：
   ```bash
   APP=src-tauri/target/release/bundle/macos/MeetingCast.app
   codesign -dvv "$APP/Contents/MacOS/meetingcast"
   codesign -dvv "$APP/Contents/MacOS/stt_engine"
   codesign -d --entitlements - "$APP/Contents/MacOS/stt_engine" 2>&1 | grep "Key"
   ```
   預期 `flags=0x10002(adhoc,runtime)` + `Sealed Resources version=2` + 5 個 entitlement Key
7. 收件人裝完務必 `xattr -cr /Applications/MeetingCast.app`（quarantine + ad-hoc 在 Sequoia 直接報 damaged）

**dev 機跑 OK ≠ ship OK**。今天 0.1.6→0.1.14 連 9 個版本的失敗在 dev 機都看不到，只有真實 fresh Mac 會炸。詳細為何見 memory file。

## 核心原則

- **回應一律繁體中文**
- **Plan before action**：新功能 / 重構先提計畫等使用者確認
- **One task at a time**：做完驗證再進下一步
- **延遲第一優先**：架構決策以「降低使用者感知延遲」為標準
- **STT 預設 local，openai cloud 為使用者選項**：成本與隱私考量

## 技術棧

| 層級 | 技術 |
|---|---|
| 桌面框架 | Tauri 2.x + React 19 + TypeScript |
| UI | Tailwind v4 + 自訂 `@theme paper-*` token |
| STT (local) | mlx-whisper（pin `<0.21`，Sequoia 相容） |
| STT (cloud) | OpenAI Realtime Whisper |
| VAD | silero-vad |
| 翻譯 / 總結 | Anthropic Claude Haiku 4.5 streaming（總結用 Sonnet 4.6） |
| Python ↔ Rust | Tauri sidecar + line-delimited JSON over stdio |
| 全域 hotkey | `tauri-plugin-global-shortcut`（⌘+Shift+M） |

## 階段現況

- Phase 1–3 完成（CLI pipeline / Tauri 骨架 / 多視窗 UX）
- Phase 4 大部分完成：設定 UI、crash 重啟、hotkey、Welcome wizard、hallucination 防禦、MicMeter、可分發 dmg、術語表全鏈路、會議紀錄 + AI 總結
- 剩：Markdown 三語匯出、log 檔案輪替、真人麥克風 live test
- 暫不做：字體 / 視窗外觀 GUI 設定、歷史會議搜尋、雲端同步、對方發言反向翻譯

## 開發守則

- 分支 `main` / `dev` / `feature/xxx`，每 phase 結束打 tag
- Conventional commits：`feat` / `fix` / `refactor` / `docs` / `test` / `chore`
- 每 phase 結束驗收報告必含第一 token 延遲 P50/P95
- 測試重點：Python 測 VAD 切片 + JSON 協定；Rust 測 sidecar 通訊 + 視窗管理；React 測譯文捲動 + 淡出

### 不要做

- 不要在 sidecar 裡做翻譯（金鑰與重試集中在 Tauri）
- 不要把 Whisper 模型打包進安裝包（首次啟動下載 ~1.5 GB）
- 不要用 WebSocket 傳 sidecar 訊息（stdio 夠用且更穩）
- 不要追求「完美翻譯」，追求「夠好且即時」
- 不要在元件寫 `bg-[#xxx]` 硬編碼色，走 `App.css` token
- 不要忘了 dev 模式 stale binary 陷阱

## 環境

macOS 13+（Apple Silicon 強烈推薦） / Python 3.13+ / Node.js 20+ / Rust 1.75+ / 麥克風權限。首次啟動下載 Whisper `large-v3-turbo` ~1.5 GB。

## 設定檔

`~/Library/Application Support/MeetingCast/config.toml`：

```toml
[api]                    # ✅ Settings UI 可改
provider = "anthropic"   # 翻譯+總結的 LLM："anthropic"（預設）| "openai"
anthropic_api_key = "sk-ant-..."
openai_api_key = ""      # openai 翻譯引擎或 openai 辨識 backend 才需要
model = "claude-haiku-4-5"
summary_model = "claude-sonnet-4-6"
openai_model = "gpt-5.6-luna"           # provider = openai 時的翻譯模型
openai_summary_model = "gpt-5.6-sol"    # provider = openai 時的總結模型

[audio]                  # ✅ Settings UI 可改
input_device = ""        # 空 = 系統預設

[language]               # ✅ Settings UI 可改（語言設定區）
source = "zh"            # 源語言，zh/en/ja/vi 任選（km 為 target-only 不可當源）
target_slots = ["en", "vi"]  # 恆長度 2，各槽位一個目標語言（zh/en/ja/vi/km）；"" = 關閉該槽位

[[glossaries]]           # ✅ Settings UI 可改（術語表 modal）
name = "預設"
[[glossaries.entries]]
term = "紫微斗數"        # → Whisper initial_prompt（top 30）
aliases = ["紫薇斗數"]   # → 後處理替換 is_final transcript
en = "Zi Wei Dou Shu"    # → 翻譯 / 總結 system prompt 注入
vi = "Tử Vi Đẩu Số"

active_glossary = "預設"

# [stt] / [vad] / [ui] 暫 hardcoded（schema 已預留 Phase 5）
```

**API key 載入**：app 啟動讀 `config.toml` → 欄位空時 dev 模式 fallback dotenvy 從 `prototype/.env` seed → Settings UI 改值 persist 回 config.toml。

**Errors log**：`~/Library/Application Support/MeetingCast/errors.log`，JSON-lines 每行 `{timestamp, category, message, context}`。

## 參考連結

- [Tauri 2.0](https://v2.tauri.app/) / [global-shortcut plugin](https://v2.tauri.app/plugin/global-shortcut/)
- [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) / [silero-vad](https://github.com/snakers4/silero-vad)
- [Anthropic streaming](https://docs.claude.com/en/docs/build-with-claude/streaming) / [prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
