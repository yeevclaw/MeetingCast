# 專案目錄結構

```
translationintime/
├── CLAUDE.md                       # 專案規格與架構決策（主要參考）
├── PROJECT_STRUCTURE.md            # 本文件
├── package.json / pnpm-lock.yaml / vite.config.ts / tsconfig.json
│
├── src/                            # React 前端（單一 bundle，依視窗 label 路由）
│   ├── main.tsx                    # 入口；getCurrentWindow().label 決定 render 哪個視窗
│   ├── App.css                     # Tailwind v4 + @theme paper-* 統一色票
│   ├── windows/
│   │   ├── ControlWindow.tsx       # 主控：start/stop、backend、逐字稿、toast、modal、音量條
│   │   └── TranslationWindow.tsx   # 譯文視窗（t1/t2 槽位共用，slotIndex 區分，語言由 config 解析）
│   ├── components/
│   │   ├── SettingsModal.tsx       # 設定（API key / 模型 / backend / 音源）
│   │   ├── WelcomeWizard.tsx       # 首次啟動引導
│   │   └── MicMeter.tsx            # 10 段 VU 音量條
│   └── lib/
│       ├── errors.ts               # 後端錯誤字串 → 使用者友善訊息
│       └── types.ts                # 共用 TS 型別
│
├── src-tauri/                      # Tauri Rust 後端
│   ├── tauri.conf.json             # 視窗、bundle、externalBin: stt_engine
│   ├── Cargo.toml
│   ├── capabilities/default.json   # 視窗權限（set-always-on-top、set-decorations）
│   ├── binaries/                   # PyInstaller 產物：stt_engine-aarch64-apple-darwin
│   └── src/
│       ├── main.rs                 # 入口
│       ├── lib.rs                  # Tauri Builder + 多視窗 + global shortcut + commands
│       ├── sidecar.rs              # spawn / watchdog / stdio 解析 / event 廣播
│       ├── translator.rs           # Anthropic SSE streaming，emit translation:chunk:<lang>
│       ├── config.rs               # config.toml 讀寫、dotenv seed
│       └── errors.rs               # JSON-lines errors.log
│
├── python-sidecar/                 # STT 引擎（PyInstaller 打包成 binary）
│   ├── stt_engine.py               # asyncio 主程式，line-delimited JSON over stdio
│   └── protocol.py                 # 訊息型別定義
│
├── prototype/                      # Phase 1 CLI 原型；同時是 canonical Python STT 模組來源
│   ├── cli.py                      # 麥克風 / WAV / VAD / 翻譯 demo
│   ├── audio_capture.py / audio_stream.py / vad.py
│   ├── translator.py               # CLI 版翻譯（Tauri 不用，留作測試）
│   ├── latency_bench.py
│   ├── requirements.txt
│   ├── samples/                    # 測試 wav
│   └── stt/                        # backend 抽象（sidecar 透過 sys.path 借用）
│       ├── base.py                 # Transcript 型別
│       ├── local.py                # MLXWhisperSTT（預設）
│       ├── openai_realtime.py      # OpenAIRealtimeWhisperSTT（cloud）
│       └── __init__.py             # get_backend(name)
│
├── docs/
│   └── LATENCY.md                  # 延遲量測（P50/P95）
│
├── scripts/
│   └── build-sidecar.sh            # PyInstaller + codesign + smoke test
│
└── tests/python/                   # （僅骨架）
```

## 各模組職責

### `src/`
單一 React bundle，三個視窗共用。`main.tsx` 用 `getCurrentWindow().label`（`control` / `t1` / `t2`）決定 render 控制或譯文視窗；譯文視窗顯示的語言由 config `[language].target_slots` runtime 解析（不綁 label）。Tailwind v4，所有色彩走 `App.css` 的 `@theme paper-*` token（warm paper / 墨色，狀態色都在暖色家族內）。

### `src-tauri/src/`
- **lib.rs** Tauri Builder、註冊三個 WebviewWindow、global shortcut `Cmd+Shift+M`、暴露給前端的 commands：`start_stt` / `stop_stt` / `translate` / `clear_translation_context` / `get_config` / `set_config` / `sidecar_ready` / `open_config_folder` / `open_errors_log`
- **sidecar.rs** spawn Python child、stdio 行解析、watchdog（3 次 2s backoff 重啟）。emit 事件：`transcript` / `stt:ready` / `stt:prewarm` / `stt:started` / `stt:stopped` / `stt:error` / `stt:crashed` / `stt:restored` / `stt:fatal` / `stt:model_loading` / `stt:model_ready` / `session:reset`
- **translator.rs** reqwest+rustls SSE。per-utterance id 防 chunk 交錯。emit `translation:chunk:<lang>` / `translation:done:<lang>`
- **config.rs** toml 持久化；dev fallback 從 `prototype/.env` seed
- **errors.rs** 結構化 JSON-lines log

### `python-sidecar/stt_engine.py`
Long-running asyncio。命令進：`start` / `stop` / `shutdown`。事件出：`ready` / `started` / `transcript` / `stopped` / `error` / `prewarm` / `model_loading` / `model_ready`。從 `sys.path` 借 `prototype/stt/` 的 backend 實作。

### `prototype/`
Phase 1 CLI，但目前**仍是 canonical Python STT 模組來源**（sidecar 沿用 `stt/` 子目錄）。等 Phase 5+ 才考慮搬移。

## Sidecar 整合與 dev/prod 路徑解析

`tauri.conf.json`：
```json
"externalBin": ["binaries/stt_engine"]
```

`sidecar.rs::locate_sidecar()` 順序：
1. 找 main exe 同目錄的 `stt_engine` 或 `stt_engine-<triple>`（prod 與 dev 都會找到）
2. fallback：`prototype/.venv/bin/python python-sidecar/stt_engine.py`

**dev 模式坑**：`pnpm tauri dev` 會把 `binaries/stt_engine-<triple>` 自動複製到 `target/debug/`，所以 dev 也會吃 PyInstaller bundle，**Python 改動完全不會生效**。要測 Python 修改，須先把 `target/debug/stt_engine*` 移開（rename 成 `.bak`），sidecar.rs 才會 fallback 到 venv Python。

## 多視窗事件流

```
[Sidecar] --stdio JSON--> [Rust sidecar.rs]
                              │
                              ▼ emit("transcript", payload)
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
         [Control]        [t1 slot]       [t2 slot]
              │
              │ control 收到 is_final → invoke("translate", id, text, target)
              ▼
        [Rust translator.rs] --SSE--> Anthropic API
              │
              ▼ emit("translation:chunk:{t1}") / ("translation:chunk:{t2}")
         [t1 Window]        [t2 Window]
```

## 設定與 log 位置（macOS）

- 設定：`~/Library/Application Support/MeetingCast/config.toml`
- 錯誤 log：`~/Library/Application Support/MeetingCast/errors.log`（JSON-lines，append-only）

## 主要相依套件

| 層 | 套件 |
|---|---|
| Frontend | React 19 + TypeScript + Tailwind v4 + Vite 7 |
| Tauri | tauri 2.x + global-shortcut + opener、reqwest+rustls、tokio、dotenvy |
| Python sidecar | mlx-whisper、silero-vad、sounddevice、numpy、websockets、soundfile |
| Build | PyInstaller（sidecar）、Tauri bundler（`.app` / `.dmg`） |
