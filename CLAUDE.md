# MeetingCast - 即時會議翻譯助手

## 專案目標

協助使用者在實體會議中進行中文報告時，**即時** streaming 將語音轉寫為中文，並**並行翻譯**成英文與越南文，分別顯示在兩個獨立視窗，供外籍同仁閱讀，本程式最注重二大條件是準確性和速度，不考慮成本，一切以使用者體驗最佳為開發目標。

**MVP 範圍：單向**（中文 → 英文 + 越南文），不處理對方發言

## 專案現況（2026-04-26）

Phase 1 CLI 原型 + Phase 2 Tauri 骨架 + Phase 3 多視窗 + Phase 4 部分（設定 UI、sidecar crash 自動重啟、全域 hotkey、錯誤 log）皆完成。`pnpm tauri build` 可端到端產出 `.app` + `.dmg`。

剩下：等 macOS 麥克風權限到位後跑真人 live test、Markdown 三語匯出、PyInstaller 打包 sidecar、log 檔案輪替。

延遲報告見 `docs/LATENCY.md`：感知延遲 P50 ~2.3s ✅、P95 ~3.1s ⚠️。

關鍵架構決策（不要重新討論）：
- **STT 引擎用 mlx-whisper**（不是 faster-whisper）— ctranslate2 在 macOS 沒 Metal 支援，CPU 只有 4.3s 太慢；mlx-whisper Metal GPU 跑 0.9s
- **雙 backend、使用者可選**：`MLXWhisperSTT`（local，預設）+ `DeepgramSTT`（cloud），皆 implement 同一 `Transcript` stream 介面，控制視窗有切換 UI
- **Cloud 用 Deepgram**（不是 Google Chirp 2 / Azure）— 設定最單純
- **Deepgram SDK 6.1.1 bool serialization bug**：要傳字串 `"true"` 而非 Python `True`，繞過方式在 `stt/cloud.py` 有註解
- **翻譯在 Rust，不在 sidecar**：Anthropic API call 由 `src-tauri/src/translator.rs` 處理，sidecar 只負責 STT
- **Sidecar 訊息協定**：line-delimited JSON over stdio（不是完整 JSON-RPC），命令 in: `start` / `stop` / `shutdown`，事件 out: `ready` / `started` / `transcript` / `stopped` / `error`
- **翻譯 chunk 帶 utterance id**：避免並行翻譯時 chunk 在 UI 交錯（commit c2b0173）

## 常用指令

> Phase 1 已可運作；Phase 2+ 待 Tauri 開工後填。

### Phase 1（Python CLI，路徑相對於 `prototype/`）
- 環境：`python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt`
- 設定：`cp .env.example .env`（填 `ANTHROPIC_API_KEY` 與 `DEEPGRAM_API_KEY`）
- 麥克風 live：`.venv/bin/python cli.py --mic --backend local --translate`
- WAV 模擬麥克風：`.venv/bin/python cli.py --mic-sim samples/weather_90s.wav --backend local --translate`
- VAD 切句 demo（含每段延遲）：`.venv/bin/python cli.py --vad-demo samples/weather_90s.wav --translate`
- 純翻譯測試：`.venv/bin/python cli.py --text "中文句子"`
- 延遲基準：`.venv/bin/python latency_bench.py samples/weather_90s.wav --output ../docs/LATENCY.md`

### Phase 2+（Tauri 桌面版）
- 開發模式：`./scripts/dev.sh`
- 打包 sidecar：`./scripts/build-sidecar.sh`
- 打包 app：`./scripts/build-app.sh`
- Rust 測試：`cd src-tauri && cargo test`
- React 測試：`pnpm test`

## 核心原則

- **回應一律使用繁體中文**
- **Plan before action**：每次新功能或重構先提計畫，等使用者確認再動手
- **One task at a time**：一次只做一件事，做完驗證再進下一步
- **延遲是第一優先**：所有架構決策以「降低使用者感知延遲」為標準
- **STT 預設本地、Cloud 為使用者選項**：預設用 mlx-whisper 本地跑（成本與隱私考量），但保留 Deepgram cloud backend 讓使用者在控制視窗自行切換（網路差或想要 interim 預覽時）。兩條路徑都是支援的主路徑

## 技術棧

| 層級 | 技術 | 理由 |
|------|------|------|
| 桌面框架 | Tauri 2.x + React 18 + TypeScript | 安裝包小、記憶體低、Rust 後端穩定 |
| UI | Tailwind CSS + shadcn/ui | 快速搭建、字體控制精準 |
| STT（local 預設）| `mlx-whisper` (Python sidecar) | Mac Metal GPU 加速（faster-whisper / ctranslate2 在 macOS 無 Metal 支援） |
| STT（cloud 選項）| Deepgram (`nova-3` 或同級) | 低延遲 cloud、interim 預覽友善；網路差時可切回 local |
| VAD（語音活動偵測）| `silero-vad` | 偵測句子邊界、降低 Whisper 呼叫次數 |
| 翻譯 | Anthropic Claude Haiku 4.5 (streaming) | 低延遲、三語品質好、支援 prompt caching |
| Python ↔ Tauri | Tauri sidecar + line-delimited JSON over stdio | 簡單可靠、無需額外服務（非完整 JSON-RPC，只是 newline 分隔的 JSON 訊息） |
| 全域 hotkey | `tauri-plugin-global-shortcut` | Cmd+Shift+M 切換錄音，視窗失焦也能用 |
| 狀態管理 | Zustand | 輕量、適合多視窗共享 |
| 多視窗 | Tauri WebviewWindow API | 原生多視窗、可獨立拖到外接螢幕 |

**為什麼不用 Electron**：安裝包大三倍以上、記憶體吃重，會議工具長時間開著不適合。

**為什麼 Whisper 用 Python sidecar 而非 Rust binding**：`mlx-whisper` 生態最成熟、Mac Metal 加速最穩定（透過 Apple MLX 框架），Rust 端的 whisper.cpp binding 仍有相容性問題。

## 系統架構

```
┌──────────────────────────────────────────────────────────────┐
│                    Tauri Main Process (Rust)                  │
│  - 視窗管理（控制 + en + vi）                                  │
│  - Sidecar 生命週期 + crash watchdog（最多重啟 3 次、2s backoff）│
│  - Anthropic API call（translator.rs，SSE streaming）          │
│  - 全域 hotkey（Cmd+Shift+M → emit hotkey:toggle）             │
│  - config.toml 讀寫、errors.log JSON-lines                     │
└────────────────┬─────────────────────┬───────────────────────┘
                 │                     │
        ┌────────▼─────────┐  ┌────────▼──────────────────────┐
        │  React Frontend  │  │  Python Sidecar (stt_engine.py)│
        │  (3 個視窗)      │  │                                │
        │                  │  │  使用者選 backend：             │
        │ - 控制視窗        │  │  ┌──────────────────────────┐ │
        │ - 英文譯文視窗    │◄─┤  │ 麥克風 / WAV capture      │ │
        │ - 越南文譯文視窗  │  │  │ silero-vad               │ │
        │                  │  │  │ ├─ MLXWhisperSTT (local) │ │
        │                  │  │  │ └─ DeepgramSTT (cloud)   │ │
        │                  │  │  └────────┬─────────────────┘ │
        └────────┬─────────┘  └───────────┼──────────────────┘
                 │                        │
                 │ stream 中文逐字稿       │
                 ◄────────────────────────┘
                 │ (Tauri event "transcript")
                 │
        ┌────────▼─────────────────────┐
        │  Anthropic API (並行 2 路)    │
        │  - 中 → 英 (Haiku streaming)  │
        │  - 中 → 越 (Haiku streaming)  │
        └──────────────────────────────┘
```

## 資料流

1. Python sidecar 啟動，依使用者選的 backend 開始錄音 + VAD
2. VAD 偵測到一段完整語音（含尾端 300ms 靜音），切片送 STT（local: mlx-whisper / cloud: Deepgram streaming）
3. STT 輸出中文逐字稿，透過 stdout line-delimited JSON 傳給 Tauri Rust
4. Rust 透過 Tauri event `transcript` 廣播給三個 React 視窗
5. 控制視窗收到 `is_final=true` 的轉寫後，**並行** invoke `translate` 指令兩次（中→英、中→越），target 不同；每段帶 utterance id 防止 chunk 在 UI 交錯
6. Rust translator.rs 走 Anthropic SSE streaming，譯文 chunk emit 為 `translation:chunk:<target>`，結束 emit `translation:done:<target>`
7. 譯文視窗訂閱對應 event，用 ScrollArea 自動捲動，舊訊息淡出

**Sidecar crash 處理**：watchdog task 偵測 child 非預期退出 → emit `stt:crashed` → 等 2s backoff → 重啟並 re-issue 上次的 start 命令 → emit `stt:restored`。連續失敗 3 次 emit `stt:fatal`，前端顯示 toast。stderr 最後 50 行寫進 `errors.log`。

## 翻譯策略：句子級 vs 滾動式

**MVP 採句子級翻譯**：以 VAD 切出的完整句子為單位送翻譯。譯文穩定不跳動，聽眾體驗好。

**Phase 2 可選滾動式**：講話超過 8 秒未停頓時，強制切片翻譯，避免長句譯文太晚出。需處理「譯文覆蓋更新」的 UX。

## Prompt 設計

翻譯 prompt 採 system + user 結構，system 部分用 **prompt caching** 鎖住術語表與風格。

```
System (cached):
你是專業即時會議口譯員。將使用者輸入的中文翻譯為 {target_lang}。
規則：
1. 只輸出譯文，不要任何解釋、引號、標點修飾
2. 保留專有名詞原文（公司名、產品名、人名）
3. 口語化但專業，符合會議場合
4. 若輸入是不完整片段，仍盡力翻譯，不要回問

術語表：
- 紫微斗數 → Zi Wei Dou Shu / Tử Vi Đẩu Số
- {使用者自訂}

User:
{中文逐字稿}
```

**注意**：每次 API 呼叫都帶完整 system，靠 prompt caching 省 token。

## 視窗設計

### 控制視窗（主視窗）
- 大型開始/停止按鈕（**全域 hotkey: Cmd+Shift+M**，視窗失焦也能用）
- 即時顯示當前辨識中的中文（最後一句）+ 已 final 的歷史
- Backend 切換：local (mlx) / cloud (deepgram)
- 音源切換：麥克風 / WAV demo
- 設定按鈕：API key、模型 (Phase 4 已實作)；術語表、字體 (Phase 5 待補)
- Toast 通知：`stt:crashed` / `stt:restored` / `stt:fatal` 的視覺回饋
- 麥克風音量條（待補）
- 語言開關（英 / 越 / 兩者，待補；目前固定兩者並行）

### 譯文視窗（英文 / 越南文各一）
- 全螢幕大字（預設 32px，可調至 64px）
- 高對比配色（米白底 #F5F1E8 / 深褐字 #2A2018）
- 自動捲動到底部，可手動往上滾看歷史譯文（與控制視窗的中文逐字稿對齊）
- 最近 5 句採由亮到暗的漸層（newest=100%、oldest=30%），再往前的譯文固定在 30% 透明度但仍保留可讀性
- 視窗 always-on-top 可選
- 無邊框模式可選（投影機顯示用）

## 開發階段切分

### Phase 1：Pipeline 驗證（純 Python CLI）✅
**目標**：確認延遲與翻譯品質可接受，再決定包不包桌面版。

- `prototype/cli.py`：麥克風 → VAD → mlx-whisper → Claude API → 終端輸出
- 量測：從說話結束到譯文第一個 token 出現的延遲
- 驗收：總延遲 < 2.5 秒，譯文可讀（P50 ~2.3s ✅，見 `docs/LATENCY.md`）

**實作細節見 `PHASE1_GUIDE.md`**（環境準備、Step 1→7、latency_bench 規格、常見坑）。目錄結構見 `PROJECT_STRUCTURE.md`。

### Phase 2：Tauri 骨架 + 單視窗 ✅
- Tauri + React + TypeScript 專案初始化
- Python sidecar 整合（stdio line-delimited JSON）
- 單一視窗顯示中文逐字稿 + 兩種譯文
- 翻譯走 Rust（`translator.rs` SSE streaming）

### Phase 3：多視窗 + UX 優化 ✅
- 拆出獨立譯文視窗 (control / en / vi)，可拖到外接螢幕
- 自動捲動、舊訊息淡出
- always-on-top、無邊框模式
- 字體 ± 按鈕

### Phase 4：穩定性與匯出（進行中）
- ✅ 設定 UI + `config.toml` 持久化（API key、模型）
- ✅ Sidecar crash 自動重啟（3 次嘗試、2s backoff、re-issue last_start）
- ✅ 全域 hotkey Cmd+Shift+M
- ✅ `errors.log` JSON-lines（記 sidecar crash / API error / config save fail）
- ✅ 前端 toast 通知 crash / restored / fatal
- ⬜ 會議結束匯出三語對照 Markdown
- ⬜ Log 檔案輪替（目前是 append-only）
- ⬜ PyInstaller 打包 sidecar（目前還靠 `prototype/.venv/bin/python`，無法分發）
- ⬜ 真人麥克風 live test（等權限）

### Phase 5（暫不做）
- 術語表 GUI 管理（schema 已預留在 `config.toml`，prompt 模板的「術語表」段落留空）
- 字體大小／視窗外觀的 GUI 設定（schema 已預留，UI 還沒做）
- 歷史會議搜尋
- 雲端同步
- 對方發言反向翻譯

## 開發守則

- 分支：`main`（穩定）、`dev`（開發）、`feature/xxx`（功能）；每個 phase 結束打 tag（如 `v0.1.0-phase1`）
- Commit 用 conventional commits（`feat` / `fix` / `refactor` / `docs` / `test` / `chore`）
- 每 Phase 結束產出驗收報告，**必須**含第一 token 延遲 P50/P95
- 測試重點：Python 測 VAD 切片與 JSON 協定；Rust 測 sidecar 通訊與視窗管理；React 測譯文捲動與淡出；E2E 跑 `tests/manual/checklist.md`

### 不要做的事
- 不要在 sidecar 裡做翻譯（讓 Tauri 處理 API call，方便管理金鑰與重試）
- 不要把 Whisper 模型打包進安裝包（太大，首次啟動下載）
- 不要用 WebSocket 傳 sidecar 訊息（stdio 夠用且更穩）
- 不要追求「完美翻譯」，追求「夠好且即時」
- 不要跳過 Phase 1 直接開 Tauri。Pipeline 延遲沒驗過就投入桌面版，撞牆會整個重來

## 環境需求

- macOS 13+（Apple Silicon 強烈推薦）
- Python 3.11+
- Node.js 20+
- Rust 1.75+（Tauri 需求）
- 麥克風權限
- 首次啟動需下載 Whisper 模型（約 1.5GB for `large-v3-turbo`）

## 設定檔

`~/Library/Application Support/MeetingCast/config.toml`

```toml
[api]                                              # ✅ 已實作（Settings UI 可改）
anthropic_api_key = "sk-ant-..."
deepgram_api_key = "..."                           # cloud backend 用
model = "claude-haiku-4-5"

[stt]                                              # TODO Phase 5：目前 hardcoded 預設
model = "large-v3-turbo"  # tiny / base / small / medium / large-v3 / large-v3-turbo
device = "auto"           # auto / cpu / mps
language = "zh"

[vad]                                              # TODO Phase 5：目前 hardcoded 預設
threshold = 0.5
min_silence_ms = 300
max_speech_sec = 8

[ui]                                               # TODO Phase 5：目前是視窗內按鈕記憶
font_size_en = 32
font_size_vi = 32
always_on_top = false
borderless = false

[glossary]                                         # TODO Phase 5：prompt 模板段落保留但空
"紫微斗數" = { en = "Zi Wei Dou Shu", vi = "Tử Vi Đẩu Số" }
```

**API key 載入順序（dev vs prod）**：
1. App 啟動時讀 `~/Library/Application Support/MeetingCast/config.toml`
2. 若 `[api]` 欄位為空，dev 模式 fallback 用 `dotenvy` 從 `prototype/.env` seed（方便開發）
3. 使用者透過 Settings UI 改值會 persist 回 config.toml；下次啟動以 config.toml 為準

**錯誤 log**：`~/Library/Application Support/MeetingCast/errors.log`（JSON-lines，每行 `{timestamp, category, message, context}`）

## 參考連結

- Tauri 2.0 docs: https://v2.tauri.app/
- mlx-whisper: https://github.com/ml-explore/mlx-examples/tree/main/whisper
- silero-vad: https://github.com/snakers4/silero-vad
- Deepgram streaming: https://developers.deepgram.com/docs/live-streaming-audio
- Anthropic API streaming: https://docs.claude.com/en/docs/build-with-claude/streaming
- Anthropic prompt caching: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- tauri-plugin-global-shortcut: https://v2.tauri.app/plugin/global-shortcut/
