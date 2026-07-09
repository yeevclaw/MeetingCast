# MeetingCast

> 即時會議翻譯助手 — 中／英／日／越任一語言發言 → 兩個可配置譯文視窗同步顯示

當你向外籍同仁簡報時，MeetingCast 即時將你的語音轉寫為逐字稿，並**並行**翻譯到兩個可配置的譯文視窗，各自顯示一種目標語言。源語言與兩個目標語言皆可在設定選擇（中／英／日／越，可互選）。可拖到外接螢幕、字體可調，會議結束後可儲存逐字稿並用 AI 產生會議總結。

**核心指標**：準確、低延遲。延遲 P50 ~2.3 秒、P95 ~3.1 秒（mlx-whisper local backend，詳見 [docs/LATENCY.md](docs/LATENCY.md)）。

---

## 功能

- 🎙️ **即時 STT**：mlx-whisper（本地，Mac Metal GPU 加速）或 Deepgram nova-3（雲端，更低延遲、interim 預覽）
- 🌐 **並行翻譯**：Claude Haiku 4.5 streaming，兩個目標語言同時送出
- 🪟 **多視窗**：控制視窗 + 兩個譯文視窗（各自選目標語言、可關其一），可拖外接螢幕、釘最前、無邊框、字體 ±
- ⌨️ **全域快捷鍵**：`⌘ + Shift + M` 切換錄音
- 📝 **會議紀錄**：自動儲存來源逐字稿與各語言譯文，支援 6 種 AI 總結模板（執行摘要、會議紀要、討論重點、決策日誌、客戶通話、簡報大綱）
- 🛡️ **穩定性**：sidecar crash 自動重啟、Whisper 幻覺三層防禦、Anthropic API 自動重試
- 🔒 **資料在地**：local backend 全部運算在你電腦上，逐字稿存 `~/Library/Application Support/MeetingCast/`

---

## 系統需求

- **macOS 13+**（Apple Silicon 強烈推薦，Intel 未測試）
- 麥克風
- Anthropic API key（[申請](https://console.anthropic.com/)）
- （選用）Deepgram API key — 想用雲端 STT 才需要

首次啟動會下載 Whisper 模型約 1.6 GB（`large-v3-turbo`）。

---

## 快速開始

### 一、安裝（一般使用者）

1. 從 [Releases](https://github.com/yeevclaw/MeetingCast/releases) 下載 `MeetingCast_<version>_aarch64.dmg`
2. 開啟 dmg，把 `MeetingCast.app` 拖到 `Applications`
3. **重要**：因為是 ad-hoc 簽章，經 Safari / Slack / Email 下載會被加 quarantine，直接開啟會跳出「MeetingCast 已損毀，無法打開」對話框。需在 Terminal 跑：
   ```bash
   xattr -cr /Applications/MeetingCast.app
   ```
   （透過 AirDrop / USB 傳的不需要）
4. 雙擊開啟。首次啟動會開三個視窗（控制＋兩個譯文視窗），並在背景下載 ~1.6 GB 語音模型，進度顯示在啟動檢查清單
5. 第一次會跳麥克風授權對話框，按允許
   - 若不小心按到「不允許」：到 系統設定 → 隱私權與安全性 → 麥克風 開啟 MeetingCast，然後重新啟動 App
6. 在 Welcome wizard 填入 Anthropic API key

### 二、使用

1. 按「開始錄音」或快捷鍵 `⌘+Shift+M`
2. 用設定的來源語言發言，講完一句停頓 0.3 秒會自動切片送翻譯
3. 兩個譯文視窗會同步顯示各自目標語言的譯文
4. 結束後按「停止錄音」，紀錄自動存檔
5. 點右上角 history icon 查看歷史會議、產生 AI 總結、匯出 Markdown

---

## 開發指南

### 環境

- Python 3.13+
- Node.js 20+
- Rust 1.75+
- pnpm

### 安裝依賴

```bash
# Frontend + Tauri
pnpm install

# Python sidecar (in prototype/)
cd prototype
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env  # 填 ANTHROPIC_API_KEY 與 DEEPGRAM_API_KEY
```

### 開發模式

```bash
pnpm tauri dev
```

⚠️ **dev 模式 sidecar 陷阱**：Tauri 會把 `binaries/stt_engine-<triple>` 自動 copy 到 `target/debug/`，sidecar.rs 會優先吃這個 stale binary。修改 Python 前要先：

```bash
mv src-tauri/target/debug/stt_engine src-tauri/target/debug/stt_engine.bak
```

才會 fallback 到 venv Python。

### 測試

```bash
cd src-tauri && cargo test                                      # Rust：sidecar / verify / config / traces
cd prototype && .venv/bin/python -m unittest discover -s ../tests/python   # Python：STT hallucination gate + eval checks
```

翻譯 prompt 的離線回歸與 A/B：`prototype/eval/run_eval.py`（先 `--dry-run` 看成本，不碰網路）。細節見 [docs/LOOP_ENGINEERING.md](docs/LOOP_ENGINEERING.md)。

### 打包 .dmg

完整 SOP 在 [CLAUDE.md](CLAUDE.md#包版-sopmacos-dmg-ship-流程)（必須照走，跳步會 ship 出壞檔）：

```bash
# 1. Bump 版本（package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 三處同步）
# 2. Build sidecar（Python 改過才需要）
./scripts/build-sidecar.sh

# 3. Build .app + .dmg
pnpm tauri build

# 4. 驗證簽章
APP=src-tauri/target/release/bundle/macos/MeetingCast.app
codesign -dvv "$APP"          # Identifier=com.tpisoftware.meetingcast + flags=adhoc,runtime
defaults read "$APP/Contents/Info.plist" NSMicrophoneUsageDescription
codesign -d --entitlements - "$APP"

# 5. 乾淨機測試（強制）
tccutil reset Microphone com.tpisoftware.meetingcast
rm -rf /Applications/MeetingCast.app
open src-tauri/target/release/bundle/dmg/MeetingCast_*.dmg
# 拖 .app 到 Applications → 開啟 → 應該跳麥克風授權對話框
```

---

## 架構

```
┌──────────────────────────────────────────────────────────────┐
│                    Tauri Main Process (Rust)                  │
│  - 視窗管理（控制 + t1 + t2）                                  │
│  - Sidecar 生命週期 + crash watchdog                           │
│  - Anthropic API call（SSE streaming）                         │
│  - 全域 hotkey、config.toml、errors.log                        │
└────────────────┬─────────────────────┬───────────────────────┘
                 │                     │
        ┌────────▼─────────┐  ┌────────▼──────────────────────┐
        │  React Frontend  │  │  Python Sidecar (stt_engine)  │
        │  3 個視窗        │  │  silero-vad + mlx-whisper      │
        │                  │◄─┤  / Deepgram nova-3 (cloud)    │
        └────────┬─────────┘  └───────────────────────────────┘
                 │ Tauri event "transcript"
        ┌────────▼─────────────────────┐
        │  Anthropic API (並行 2 路)    │
        │  - 源→t1 Haiku streaming      │
        │  - 源→t2 Haiku streaming      │
        └──────────────────────────────┘
```

詳細資料流、訊息協定、技術選型理由見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 與 [CLAUDE.md](CLAUDE.md)。

---

## 技術棧

| 層級 | 技術 | 為什麼 |
|------|------|--------|
| 桌面框架 | Tauri 2 + React 19 + TypeScript | 安裝包小、記憶體低、Rust 後端穩定 |
| UI | Tailwind v4 + 自訂 `@theme paper-*` | 暖紙墨色票集中管理 |
| STT (local) | mlx-whisper | Mac Metal GPU 加速（ctranslate2 沒 Metal 支援，CPU 太慢） |
| STT (cloud) | Deepgram nova-3 | 低延遲 interim 預覽 |
| VAD | silero-vad | 偵測句子邊界，降低 Whisper 呼叫次數 |
| 翻譯 | Claude Haiku 4.5 (streaming) | 低延遲 + 多語品質 + prompt caching |
| 總結 | Claude Sonnet 4.6 | 結構化輸出品質高於 Haiku |
| Python ↔ Rust | Tauri sidecar + line-delimited JSON over stdio | 簡單可靠 |

---

## Roadmap

- [x] Phase 1：CLI pipeline 驗證（延遲基準）
- [x] Phase 2：Tauri 骨架 + 單視窗
- [x] Phase 3：多視窗 + UX
- [x] Phase 4：穩定性 + 設定 UI + 可分發 .dmg
- [x] 會議紀錄 + AI 總結（6 模板）
- [x] Whisper hallucination 機制面防禦
- [x] First-run coach mark
- [ ] 單場雙向翻譯（同時處理對方發言）— 現版本源語言可選，但一場會議仍為單向
- [ ] 術語表 GUI
- [ ] Apple Developer ID notarization（目前是 ad-hoc 簽章）

---

## License

Internal use（TPI Software）— 暫無公開授權。

---

## 鳴謝

- [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) — Apple Silicon Whisper 推論
- [silero-vad](https://github.com/snakers4/silero-vad) — VAD
- [Tauri](https://v2.tauri.app/) — 桌面框架
- [Anthropic Claude](https://www.anthropic.com/) — 翻譯與總結
