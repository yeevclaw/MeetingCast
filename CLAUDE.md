# MeetingCast - 即時會議翻譯助手

## 專案目標

協助使用者在實體會議中進行中文報告時，**即時** streaming 將語音轉寫為中文，並**並行翻譯**成英文與越南文，分別顯示在兩個獨立視窗，供外籍同仁閱讀。最重要的兩個指標是準確性和速度，不考慮成本，一切以使用者體驗最佳為開發目標。

**MVP 範圍：單向**（中文 → 英文 + 越南文），不處理對方發言

## 專案現況（2026-04-30）

Phase 1 + 2 + 3 + 大部分 Phase 4 完成。`pnpm tauri build` 端到端產出 `.app` + `.dmg`，已可分發給朋友（Apple Silicon、未簽 Apple Developer ID，需走 Gatekeeper 右鍵開啟）。

完成清單：
- 多視窗（control / en / vi）、UI 統一暖紙色票（`App.css` 的 `@theme paper-*`）
- Sidecar crash watchdog（3 次 2s backoff，re-issue last_start）
- 全域 hotkey `Cmd+Shift+M`、首次啟動引導（WelcomeWizard）、模型預載 overlay
- `errors.log` JSON-lines、設定 UI + `config.toml` 持久化
- Whisper hallucination 三層防禦
- 譯文視窗完整歷史 + 最近 5 句漸層淡出
- **MicMeter**（10 段 VU 音量條）顯示在主視窗狀態列
- 重新錄音時的清除確認框
- 翻譯 prompt + meta-response 過濾、術語表結構（內容待補）
- 第一版可分發 `.dmg`（264 MB，arm64）+ 朋友用使用說明（已存桌面）

剩下：Markdown 三語匯出、log 檔案輪替、真人麥克風 live test 後驗收。

## 關鍵架構決策（不要重新討論）

- **STT 引擎用 mlx-whisper**（不是 faster-whisper）— ctranslate2 在 macOS 沒 Metal 支援，CPU 4.3s 太慢；mlx-whisper Metal GPU 0.9s
- **雙 backend**：`MLXWhisperSTT`（local，預設）+ `DeepgramSTT`（cloud），同一 `Transcript` stream 介面，控制視窗有切換 UI
- **Cloud 用 Deepgram**（不是 Google Chirp 2 / Azure）— 設定最單純
- **Deepgram 雲端參數**：模型用 **nova-3**（不是 nova-2，後者+進階參數組合會被拒），最小配 + 必要選用參數要小心：
  - `utterance_end_ms` 最低 **1000ms**（傳 700 會回 HTTP 400 + 通用錯誤訊息「Unexpected error when initializing websocket connection」）
  - 與之搭配的 `interim_results` / `vad_events` 要一起開
  - SDK 6.x User-Agent 顯示 6.0.2 是內部硬編碼常數，非實際版本，不是問題
- **翻譯在 Rust，不在 sidecar**：Anthropic API call 由 `src-tauri/src/translator.rs` 處理；sidecar 只負責 STT
- **Sidecar 訊息協定**：line-delimited JSON over stdio（非完整 JSON-RPC）。命令 in：`start` / `stop` / `shutdown`；事件 out：`ready` / `started` / `transcript` / `stopped` / `error` / `prewarm` / `model_loading` / `model_ready`
- **翻譯 chunk 帶 utterance id**：避免並行翻譯時 chunk 在 UI 交錯
- **dev 模式 sidecar 路徑陷阱**：`pnpm tauri dev` 會把 `binaries/stt_engine-<triple>` 自動 copy 到 `target/debug/`，sidecar.rs 會優先吃這個 stale binary，Python 改動不會生效。**測 Python 修改前要先 mv 掉 `target/debug/stt_engine*`** 才會 fallback 到 venv Python
- **色票統一在 `App.css` 的 `@theme`**：`paper-50..900` warm neutral + `danger-*` / `warn-*` / `recording`，所有元件用 token 不再寫 hex

## 常用指令

### Phase 1（Python CLI，路徑相對於 `prototype/`）
- 環境：`python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt`
- 設定：`cp .env.example .env`（填 `ANTHROPIC_API_KEY` 與 `DEEPGRAM_API_KEY`）
- 麥克風 live：`.venv/bin/python cli.py --mic --backend local --translate`
- WAV 模擬麥克風：`.venv/bin/python cli.py --mic-sim samples/weather_90s.wav --backend local --translate`
- VAD 切句 demo：`.venv/bin/python cli.py --vad-demo samples/weather_90s.wav --translate`
- 純翻譯測試：`.venv/bin/python cli.py --text "中文句子"`
- 延遲基準：`.venv/bin/python latency_bench.py samples/weather_90s.wav --output ../docs/LATENCY.md`

### Tauri 桌面版
- 開發模式：`pnpm tauri dev`
- 打包 sidecar：`./scripts/build-sidecar.sh`（PyInstaller + codesign + smoke test，~5 min）
- 打包 app：`pnpm tauri build`（產 `.app` + `.dmg`，~1 min Rust release）
- Rust 測試：`cd src-tauri && cargo test`

**dev 測 Python 改動前**：`mv src-tauri/target/debug/stt_engine src-tauri/target/debug/stt_engine.bak`，否則 sidecar 會吃 stale PyInstaller binary。

## 核心原則

- **回應一律使用繁體中文**
- **Plan before action**：每次新功能或重構先提計畫，等使用者確認再動手
- **One task at a time**：一次只做一件事，做完驗證再進下一步
- **延遲是第一優先**：所有架構決策以「降低使用者感知延遲」為標準
- **STT 預設本地、Cloud 為使用者選項**：預設用 mlx-whisper 本地跑（成本與隱私考量），但保留 Deepgram cloud backend 讓使用者在控制視窗自行切換（網路差或想要 interim 預覽時）

## 技術棧

| 層級 | 技術 | 理由 |
|------|------|------|
| 桌面框架 | Tauri 2.x + React 19 + TypeScript | 安裝包小、記憶體低、Rust 後端穩定 |
| UI | Tailwind v4 + 自訂 `@theme paper-*` token | 色票集中管理，整體暖紙墨色 |
| STT (local) | `mlx-whisper` | Mac Metal GPU 加速 |
| STT (cloud) | Deepgram nova-3 | 低延遲、interim 預覽 |
| VAD | `silero-vad` | 偵測句子邊界、降 Whisper 呼叫次數 |
| 翻譯 | Anthropic Claude Haiku 4.5 (streaming) | 低延遲、三語品質好、prompt caching |
| Python ↔ Tauri | Tauri sidecar + line-delimited JSON over stdio | 簡單可靠 |
| 全域 hotkey | `tauri-plugin-global-shortcut` | Cmd+Shift+M 切換錄音 |
| 多視窗 | Tauri WebviewWindow API | 原生多視窗、可拖外接螢幕 |

**為什麼不用 Electron**：安裝包大三倍以上、記憶體吃重。
**為什麼 Whisper 用 Python sidecar 而非 Rust binding**：`mlx-whisper` 生態最成熟、Mac Metal 加速最穩定。

## 系統架構

```
┌──────────────────────────────────────────────────────────────┐
│                    Tauri Main Process (Rust)                  │
│  - 視窗管理（控制 + en + vi）                                  │
│  - Sidecar 生命週期 + crash watchdog（最多重啟 3 次、2s backoff）│
│  - Anthropic API call（translator.rs，SSE streaming）          │
│  - 全域 hotkey（Cmd+Shift+M → emit hotkey:toggle）             │
│  - config.toml / errors.log JSON-lines                         │
└────────────────┬─────────────────────┬───────────────────────┘
                 │                     │
        ┌────────▼─────────┐  ┌────────▼──────────────────────┐
        │  React Frontend  │  │  Python Sidecar (stt_engine.py)│
        │  (3 個視窗)      │  │  ┌──────────────────────────┐ │
        │                  │◄─┤  │ 麥克風 / WAV capture      │ │
        │ - 控制視窗        │  │  │ silero-vad               │ │
        │ - 英文譯文視窗    │  │  │ ├─ MLXWhisperSTT (local) │ │
        │ - 越南文譯文視窗  │  │  │ └─ DeepgramSTT (cloud)   │ │
        └────────┬─────────┘  └────────┴─────────────────────┘
                 │ (Tauri event "transcript")
        ┌────────▼─────────────────────┐
        │  Anthropic API (並行 2 路)    │
        │  - 中 → 英 (Haiku streaming)  │
        │  - 中 → 越 (Haiku streaming)  │
        └──────────────────────────────┘
```

## 資料流

1. Sidecar 啟動，依 backend 開始錄音 + VAD
2. VAD 偵測完整語音（含尾端 300ms 靜音），切片送 STT
3. 中文逐字稿透過 stdout line-delimited JSON 傳給 Rust
4. Rust emit `transcript` event 給三個視窗
5. 控制視窗收到 `is_final=true` 後**並行** invoke `translate` 兩次（中→英、中→越），每段帶 utterance id
6. translator.rs 走 Anthropic SSE，譯文 chunk emit `translation:chunk:<target>`，結束 emit `translation:done:<target>`
7. 譯文視窗訂閱對應 event，自動捲動，最近 5 句漸層淡出

**Sidecar crash 處理**：watchdog → emit `stt:crashed` → 2s backoff 重啟 → re-issue last start → emit `stt:restored`。連續 3 次 emit `stt:fatal`，前端顯示 toast。stderr 最後 50 行寫進 `errors.log`。

## Prompt 設計

System + user 結構，system 用 **prompt caching** 鎖住術語表與風格。

```
System (cached):
你是專業即時會議口譯員。將使用者輸入的中文翻譯為 {target_lang}。
規則：
1. 只輸出譯文，不要任何解釋、引號、標點修飾
2. 保留專有名詞原文（公司名、產品名、人名）
3. 口語化但專業，符合會議場合
4. 若輸入是不完整片段，仍盡力翻譯，不要回問

術語表：
- {使用者自訂}

User: {中文逐字稿}
```

每次 API call 帶完整 system，靠 prompt caching 省 token。

## 視窗設計

### 控制視窗
大型開始/停止按鈕（墨色實心，暖磚紅錄音中）+ 全域 hotkey、即時逐字稿、backend / 音源切換、設定按鈕、MicMeter（10 段 VU）、toast、crash overlay、modal（settings / 重啟確認 / welcome）。

### 譯文視窗（英 / 越）
全螢幕大字（預設 32px，可調 20–64）、暖米底 + 墨字、自動捲動 + 手動往上看歷史、最近 5 句漸層淡出（其餘 30% 透明度但仍可讀）、釘最前 / 無邊框可選。

## 開發階段切分

### Phase 1：Pipeline 驗證（CLI）✅
延遲量測 P50 ~2.3s ✅、P95 ~3.1s ⚠️（見 `docs/LATENCY.md`）。詳見 `PHASE1_GUIDE.md`。

### Phase 2：Tauri 骨架 + 單視窗 ✅
Tauri + React + sidecar stdio 整合、Rust translator SSE。

### Phase 3：多視窗 + UX ✅
拆獨立譯文視窗、自動捲動 / 淡出、always-on-top / 無邊框 / 字體 ±。

### Phase 4：穩定性與分發
- ✅ 設定 UI + config.toml + dotenv seed
- ✅ Sidecar crash 自動重啟、`errors.log`、前端 toast
- ✅ 全域 hotkey、Welcome wizard、模型預載 overlay
- ✅ Whisper hallucination 三層防禦、prompt 強化
- ✅ MicMeter、重新錄音確認框
- ✅ 統一暖紙色票
- ✅ PyInstaller 打包 sidecar、可分發 `.dmg`
- ⬜ Markdown 三語匯出
- ⬜ Log 檔案輪替（目前 append-only）
- ⬜ 真人麥克風 live test 全程驗收

### Phase 5（暫不做）
- 術語表 GUI（schema 已預留）
- 字體 / 視窗外觀的 GUI 設定（schema 已預留）
- 歷史會議搜尋、雲端同步、對方發言反向翻譯

## 開發守則

- 分支：`main` / `dev` / `feature/xxx`；每個 phase 結束打 tag
- Commit conventional commits（`feat` / `fix` / `refactor` / `docs` / `test` / `chore`）
- 每 Phase 結束產出驗收報告，**必須**含第一 token 延遲 P50/P95
- 測試重點：Python 測 VAD 切片與 JSON 協定；Rust 測 sidecar 通訊與視窗管理；React 測譯文捲動與淡出

### 不要做的事
- 不要在 sidecar 裡做翻譯（Tauri 處理 API call，金鑰與重試集中管理）
- 不要把 Whisper 模型打包進安裝包（太大，首次啟動下載）
- 不要用 WebSocket 傳 sidecar 訊息（stdio 夠用且更穩）
- 不要追求「完美翻譯」，追求「夠好且即時」
- 不要在元件裡寫 `bg-[#xxx]` 硬編碼色，走 `App.css` token
- 不要忘了 dev 模式 stale binary 陷阱（測 Python 改動前先 mv `target/debug/stt_engine*`）

## 環境需求

- macOS 13+（Apple Silicon 強烈推薦）
- Python 3.13+
- Node.js 20+
- Rust 1.75+
- 麥克風權限
- 首次啟動下載 Whisper 模型 ~1.5 GB（`large-v3-turbo`）

## 設定檔

`~/Library/Application Support/MeetingCast/config.toml`

```toml
[api]                                              # ✅ Settings UI 可改
anthropic_api_key = "sk-ant-..."
deepgram_api_key = "..."                           # cloud backend 用
model = "claude-haiku-4-5"

[stt]                                              # ⬜ Phase 5：目前 hardcoded
model = "large-v3-turbo"
device = "auto"
language = "zh"

[vad]                                              # ⬜ Phase 5：目前 hardcoded
threshold = 0.5
min_silence_ms = 300
max_speech_sec = 8

[ui]                                               # ⬜ Phase 5：目前是視窗內按鈕記憶
font_size_en = 32
font_size_vi = 32
always_on_top = false
borderless = false

[glossary]                                         # ⬜ Phase 5：prompt 模板段落保留但空
"紫微斗數" = { en = "Zi Wei Dou Shu", vi = "Tử Vi Đẩu Số" }
```

**API key 載入順序**：
1. App 啟動讀 `config.toml`
2. 欄位為空時 dev 模式 fallback `dotenvy` 從 `prototype/.env` seed
3. Settings UI 改值會 persist 回 config.toml

**錯誤 log**：`~/Library/Application Support/MeetingCast/errors.log`（JSON-lines，每行 `{timestamp, category, message, context}`）

## 參考連結

- Tauri 2.0 docs: https://v2.tauri.app/
- mlx-whisper: https://github.com/ml-explore/mlx-examples/tree/main/whisper
- silero-vad: https://github.com/snakers4/silero-vad
- Deepgram streaming: https://developers.deepgram.com/docs/live-streaming-audio
- Deepgram utterance_end: https://developers.deepgram.com/docs/utterance-end
- Anthropic API streaming: https://docs.claude.com/en/docs/build-with-claude/streaming
- Anthropic prompt caching: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- tauri-plugin-global-shortcut: https://v2.tauri.app/plugin/global-shortcut/
