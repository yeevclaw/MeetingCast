# 專案目錄結構

```
meeting-translator/
├── CLAUDE.md                       # 專案總規格（Claude Code 主要參考）
├── PROJECT_STRUCTURE.md            # 本文件
├── README.md                       # 使用者說明
├── .gitignore
├── .env.example                    # API key 範本
│
├── prototype/                      # Phase 1：CLI 原型驗證
│   ├── README.md
│   ├── requirements.txt
│   ├── cli.py                      # 主程式：mic → VAD → Whisper → Claude → stdout
│   ├── audio_capture.py            # 麥克風串流
│   ├── vad.py                      # silero-vad 包裝
│   ├── stt.py                      # faster-whisper 包裝
│   ├── translator.py               # Claude API 呼叫（async streaming）
│   ├── latency_bench.py            # 延遲量測腳本
│   └── samples/                    # 測試用音檔
│       ├── zh_short.wav
│       └── zh_long.wav
│
├── src-tauri/                      # Tauri Rust 後端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/
│   ├── binaries/                   # Python sidecar 打包後放這
│   │   └── stt_engine-aarch64-apple-darwin
│   └── src/
│       ├── main.rs                 # 入口
│       ├── lib.rs
│       ├── windows.rs              # 多視窗建立與管理
│       ├── sidecar.rs              # Python sidecar 啟動與 stdio 通訊
│       ├── translator.rs           # Anthropic API 呼叫（reqwest + streaming）
│       ├── config.rs               # 設定檔讀寫
│       ├── events.rs               # 事件型別定義
│       └── commands.rs             # Tauri command handlers
│
├── src/                            # React 前端
│   ├── main.tsx                    # 入口（依視窗 label 路由）
│   ├── App.tsx
│   ├── index.css
│   │
│   ├── windows/                    # 三個視窗的 root component
│   │   ├── ControlWindow.tsx       # 主控視窗
│   │   ├── TranslationWindow.tsx   # 譯文視窗（英/越共用，由 prop 區分）
│   │   └── SettingsWindow.tsx      # 設定視窗
│   │
│   ├── components/
│   │   ├── ui/                     # shadcn/ui 元件
│   │   ├── MicButton.tsx           # 大型錄音按鈕
│   │   ├── VolumeIndicator.tsx     # 音量條
│   │   ├── TranscriptStream.tsx    # 中文逐字稿即時顯示
│   │   ├── TranslationStream.tsx   # 譯文串流顯示（含淡出邏輯）
│   │   └── LanguageToggle.tsx
│   │
│   ├── stores/                     # Zustand stores
│   │   ├── sessionStore.ts         # 錄音 session 狀態
│   │   ├── transcriptStore.ts      # 逐字稿與譯文歷史
│   │   └── configStore.ts          # 設定
│   │
│   ├── hooks/
│   │   ├── useTauriEvent.ts        # 訂閱 Rust 端事件
│   │   ├── useTranslation.ts       # 觸發翻譯
│   │   └── useAutoScroll.ts
│   │
│   ├── lib/
│   │   ├── tauri.ts                # Tauri API 包裝
│   │   ├── anthropic.ts            # 翻譯 prompt 建構
│   │   └── glossary.ts             # 術語表處理
│   │
│   └── types/
│       ├── events.ts               # 與 Rust 端共用的事件型別
│       └── config.ts
│
├── python-sidecar/                 # Python STT 引擎（會被 build 成 binary）
│   ├── pyproject.toml
│   ├── stt_engine.py               # 主程式（stdio JSON-RPC server）
│   ├── audio.py                    # 麥克風 capture
│   ├── vad.py                      # silero-vad
│   ├── whisper_worker.py           # faster-whisper 推論
│   ├── protocol.py                 # JSON-RPC 訊息定義
│   └── build.sh                    # PyInstaller 打包腳本
│
├── tests/
│   ├── python/
│   │   ├── test_vad.py
│   │   ├── test_whisper.py
│   │   └── test_protocol.py
│   ├── rust/
│   │   └── (cargo test 在 src-tauri 內)
│   ├── react/
│   │   ├── TranslationStream.test.tsx
│   │   └── stores.test.ts
│   └── manual/
│       └── checklist.md            # E2E 手動測試清單
│
├── docs/
│   ├── ARCHITECTURE.md             # 架構深入說明
│   ├── PROTOCOL.md                 # Sidecar JSON-RPC 協定
│   ├── PROMPTS.md                  # 翻譯 prompt 設計與調校紀錄
│   ├── LATENCY.md                  # 延遲量測結果與優化紀錄
│   └── TROUBLESHOOTING.md
│
├── scripts/
│   ├── dev.sh                      # 開發模式啟動（含 sidecar）
│   ├── build-sidecar.sh            # 打包 Python sidecar
│   ├── build-app.sh                # 打包整個 app
│   └── download-models.sh          # 下載 Whisper 模型
│
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── tsconfig.json
└── tailwind.config.ts
```

## 各模組職責

### `prototype/`
**唯一目的**：在投入 Tauri 之前，先用 Python CLI 跑通整條 pipeline，量測真實延遲。如果延遲不可接受，就要重新評估技術選型（例如改用 Deepgram 雲端 STT）。**Phase 1 完成後，這個目錄就凍結，不再維護。**

### `src-tauri/`
- `windows.rs`：建立三個 WebviewWindow（control / english / vietnamese），定義各自的 size、position、decorations
- `sidecar.rs`：spawn Python binary，建立 stdin/stdout pipe，解析 JSON-RPC 訊息，emit 給前端
- `translator.rs`：呼叫 Anthropic API，處理 streaming SSE，按 chunk emit 給對應視窗
- `commands.rs`：暴露給前端的命令（start_recording / stop_recording / update_config / export_transcript）

### `src/windows/`
三個視窗共用 React 程式碼，但 entry point 不同：
- 在 `main.tsx` 用 `getCurrentWindow().label` 判斷要 render 哪個 window component
- 控制視窗：完整 UI
- 譯文視窗：極簡，只有譯文流 + 最少 chrome

### `python-sidecar/`
- 設計成「**啟動後就持續吃音訊吐文字**」的長駐程式
- 透過 stdin 接收控制命令（start / stop / change_model）
- 透過 stdout 送出三種訊息：`transcript_partial`（VAD 中）、`transcript_final`（句子完成）、`error`
- 用 PyInstaller 打包成單一 binary，放進 `src-tauri/binaries/`

## 與 Tauri Sidecar 的整合

Tauri 2.0 sidecar 設定範例（`tauri.conf.json`）：

```json
{
  "bundle": {
    "externalBin": ["binaries/stt_engine"]
  }
}
```

執行檔命名規則：`stt_engine-{target_triple}`，例如 Mac Apple Silicon 是 `stt_engine-aarch64-apple-darwin`。

## 多視窗事件流

```
[Python Sidecar] --stdout JSON--> [Rust sidecar.rs]
                                        |
                                        v
                              emit("transcript:final", payload)
                                        |
                    +-------------------+--------------------+
                    |                   |                    |
                    v                   v                    v
            [Control Window]    [English Window]    [Vietnamese Window]
                    |
                    | (control window 觸發翻譯)
                    v
            invoke("translate", {text, target: "en"})
                    |
                    v
            [Rust translator.rs] --SSE--> Anthropic API
                    |
                    v
            emit("translation:chunk:en", chunk)  --> [English Window]
            emit("translation:chunk:vi", chunk)  --> [Vietnamese Window]
```

## 設定檔位置

| 平台 | 路徑 |
|------|------|
| macOS | `~/Library/Application Support/MeetingCast/config.toml` |
| 開發 | `./.dev-config.toml`（git-ignored） |

## 依賴套件清單（重點）

### Python (`python-sidecar/pyproject.toml`)
```
faster-whisper >= 1.0.3
silero-vad >= 5.1
sounddevice >= 0.4.6
numpy >= 1.26
```

### Rust (`src-tauri/Cargo.toml`)
```
tauri = { version = "2", features = ["macos-private-api"] }
tauri-plugin-shell = "2"
tauri-plugin-store = "2"
reqwest = { version = "0.12", features = ["stream", "json"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
eventsource-stream = "0.2"
```

### Node (`package.json`)
```
"@tauri-apps/api": "^2",
"@tauri-apps/plugin-shell": "^2",
"react": "^18",
"zustand": "^4",
"tailwindcss": "^3",
"shadcn-ui components"
```
