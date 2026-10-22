# 計畫：串流 STT 細切分 + 增量翻譯（同步口譯模式）

> 2026-09-02 定案。目標：讓譯文更接近真人同步口譯的反應方式 —— 不等句尾就開口、落後恆定不累積、說出去的譯文不收回。此階段只做**文字**；TTS 朗讀與 LiveKit 廣播是後續階段，會直接接在本管線之後。

## 背景與現況

- OpenAI `gpt-live-transcribe` backend 已逐字吐 delta（`is_final=false`），並在句末標點提前切 final（`_SentenceSplitter`）。VAD 靜音門檻 300ms、`delay: "low"` 已設。程式註解實測 **delta 落後語音約 1.3 秒**，這是 STT 端底線。
- 翻譯編排在前端：ControlWindow 收到 final 才 `invoke("translate")`，並用 pending map 等所有目標語言完成後寫 `transcript.jsonl`。Rust `translate` 是無狀態單次呼叫，帶最近 2 對上下文。
- 本地 mlx-whisper 是批次模型，只能在 VAD 句尾出 final；走同一條新管線時每句是「單片段句群」，行為等同今天。
- 現況感知延遲（句級、zh 源）：P50 ≈ 2.3s、P95 ≈ 3.1s（`docs/LATENCY.md`）。

## 真人口譯的四個特徵（設計依據）

| 特徵 | 現況 | 本計畫 |
|---|---|---|
| 不等句尾就開口 | 等 VAD 句尾 / 句末標點 | 語意單位（5–15 字）就送翻譯 |
| 落後恆定 | 文字模式不累積 | 量測 `interp:lag`，給後續 TTS 落後控制用 |
| 落後時壓縮 | 無 | 預留 `set_interp_mode`，本階段不動作 |
| 說出去不收回 | 句級整句輸出 | 以續句追加；中文本次續句可因字形轉換或正式術語補齊而修正顯示 |

## 設計

### 單位定義

- **片段（segment）**：Python splitter 切出的語意單位。切點優先序：句末標點 > 逗號／頓號／分號 > 語篇標記詞（然後、所以、但是、不過、另外、那麼、首先、接下來、第一…）> 長度上限強制切。少於下限的片段吊著併入下一段。
  - zh / ja：下限 4 字、上限 15 字
  - en / vi（空白分詞語言）：下限 12 字元、上限 60 字元，強制切在空白處
- **句群（group）**：從一個片段開始，到「句末標點」「VAD 句尾（item 完成）」或「累積超過 40 字」為止。句群對應今天的 utterance：一筆 `transcript.jsonl`、譯文視窗一行、一個 `id`。

### 協定變更（sidecar → Rust → 前端）

`transcript` 事件新增可選欄位 `boundary`：

| 值 | 意義 | Rust 對句群的動作 |
|---|---|---|
| `clause` | 逗號 / 語篇標記詞切出 | 保持開放 |
| `forced` | 長度上限強制切 | 保持開放 |
| `sentence` | 句末標點 | 關閉 |
| `pause` | item 完成（VAD 句尾或 15s 強制 commit） | 關閉 |

本地 backend 一律送 `sentence`。欄位缺省時 Rust 視為 `sentence`，舊 binary 相容。

### 增量翻譯引擎 `src-tauri/src/interp.rs`

- sidecar.rs 的 stdout reader 把 final 片段直接餵給引擎，不再經前端。
- 每個目標語言一條**序列化工作隊列**：一次只有一個 API call 在飛；飛行中到達的新片段合併成下一次呼叫（自然限制呼叫頻率）。
- 每次呼叫送：句群目前為止的源文、已送出的譯文、最近 2 組上下文。模型只輸出**續句**；可回空字串表示「等下一段」。句群關閉時最後一次呼叫要求補完，不准再等。
- **續句與重複前綴由 Rust 處理**：模型重複已輸出前綴 → 剝掉；前綴不符 → 記 `errors.log`，只取續句部分。
  - 主路徑候選：Anthropic assistant prefill（把已輸出譯文放在 assistant 開頭讓模型接著寫，結構上保證不改前文）。需驗證 Haiku 4.5 支援。
  - OpenAI provider 走標籤版（`<emitted>…</emitted>`）。
- 事件沿用 `translation:chunk:{lang}`（id = 句群 id）；句群關閉時發 `translation:done:{lang}`。中文保留本次呼叫原文，隨 SSE 詞組上下文重新轉換；若已顯示前綴改變，送 `translation:replace:zh`，`{id, text}` 的 text 為「先前已輸出譯文＋本次完整續句」，前端取代該 id 全文。累積的 `emitted` 與 session 使用同一份顯示文字。其他語言維持追加。Rust 自己寫 session，前端 pending map 移除。
- 中文字形轉換保留繁簡共用字與術語表正式名稱；STT 先轉換，再套用同樣轉換過的別名。中文目標遇到英文字母開頭的模型回覆，仍放寬到 32 字再判斷英文前言，避免說明文字漏到投影畫面。
- 新 prompt 檔 `src-tauri/prompts/interpret_system.txt`；`translate_system.txt` 不動。共用 glossary 注入與 meta 過濾。
- TraceGuard 新 kind `translate_inc`，欄位同 `translate`。

### 使用者開關與費用提醒

- Config 新增 `[interp] mode = "sentence" | "incremental"`，**預設 `sentence`**（維持今天行為，使用者主動開啟）。
- Settings 新增「同步口譯模式」開關。**開啟時跳確認對話框**，內容：
  - 翻譯 API 呼叫次數約增加為 3–4 倍
  - 翻譯費用估計增加約 **+300%～+400%**（每小時約 $0.15 → $0.7 美金，兩個目標語言）
  - 對 STT、總結費用無影響
  - 需按「確認開啟」才生效；關閉不提示
- 百分比與每小時金額放在一個常數（`src/lib/cost.ts`），階段 4 量測後更新。

### 成本影響

每小時約 900 片段 × 2 語言 ≈ 1,800 次呼叫，每次輸入約 200 token、輸出約 40 token，system prompt 走 prompt cache。翻譯成本約 $0.15/hr → $0.7/hr。0.5 req/s，遠低於 rate limit。

## 分階段

| 階段 | 內容 | 工時 | 驗收 | 計費 API |
|---|---|---|---|---|
| 0 基線 | weather_90s.wav 走 openai backend，從 traces.jsonl 量「片段 final → 譯文首 token」「講者說出字 → 譯文首字」 | 0.5d | 有 P50/P95 可比 | 是（< $0.2） |
| 1 細切分 | Python splitter v2 + `boundary` 欄位 + 兩個 backend；擴充 `tests/python/test_sentence_split.py`；Rust/TS 型別加欄位 | 1d | 單元測試過；90s 樣本 80% 片段落在 5–15 字 | 否 |
| 2 引擎 | `interp.rs`：句群狀態機、序列化隊列與合併、續句 prompt 與前綴剝除、句群關閉寫 session、TraceGuard、`[interp]` config | 2–3d | 狀態機與前綴處理有單元測試；`cargo test` 全綠 | prefill 驗證（< $0.1） |
| 3 前端 | Settings 開關 + 費用確認框；incremental 模式下 ControlWindow 不再 invoke translate、移除 pending map；TranslationWindow 開放句群游標 | 1d | 兩種模式切換 history 與總結正常 | 否 |
| 4 評測 | `run_eval.py` 加增量 golden（逐片段餵入、append-only 違規 = 0、拼接品質不劣於句級）；`latency_bench.py` 出 P50/P95 | 1–2d | 首字 P50 ≤ 2.0s、P95 ≤ 2.8s；≥ 90% 案例不劣於句級 | 是（< $0.5） |
| 5 收尾 | 更新 `docs/ARCHITECTURE.md`、`docs/LATENCY.md`、CLAUDE.md；打 tag | 0.5d | 文件同步 | 否 |

計費 API 呼叫（階段 0 / 2 / 4）執行前逐次確認。

### 進度（2026-09-02）

- 階段 0 ✅、階段 1 ✅、階段 2 ✅（`interp.rs`，12 個單元測試）、階段 3 ✅（Settings 開關 + 費用確認框 + openai delay 選單）。
- 順帶納入：`[stt] openai_delay` 預設 `minimal`；source=zh 時 sidecar 固定前置繁體 prompt（`ZH_TW_SCRIPT_PROMPT`）。
- 細切分只在 `segmentation: fine`（incremental 模式）啟用；sentence 模式的 splitter 行為與 0.1.25 相同。
- **Live 驗證 ✅（2026-09-02 23:31，dev app 自動跑 demo WAV 100s，openai + incremental，目標 en/ja）**：19 個句群全部寫入 transcript.jsonl、0 incomplete、errors.log 無新錯；86 次 `translate_inc` 呼叫（82 ok / 4 empty、0 retry）；TTFT P50 653 / P95 943 ms，整次 P50 804 ms；譯文跨句群連貫（context 生效）、只追加。修了一個接縫空白 bug（續句開頭的空白／換行造成雙空格）。
- **實測成本**：每次呼叫平均 818 input / 15 output tokens；**prompt cache 從未命中**——Haiku 4.5 最小可快取前綴 4,096 tokens，我們的 system prompt 約 500，sentence 模式同樣從未命中（既有文件寫的「prompt caching 省 token」不成立）。換算：incremental ≈ US$2.8／小時連續說話，sentence ≈ US$1.1，倍率約 2.5×；Settings 提示改為「2–3 倍、+150%～+200%、每小時約 0.6 → 1.5」（以每小時 30 分鐘語音計）。
- 已知小瑕疵：zh-tw prompt 下 90s 樣本尾段仍出現少量簡體字；`forced` 切點偶爾切在詞中間，但譯文看整個句群源文，不受影響。
- 未做：階段 4 評測（需計費）、階段 5 文件收尾（ARCHITECTURE / LATENCY）。
- 已知取捨：incremental 續句不做 `wrong_language` 檢查（片段太短誤判多）；首 chunk 前緩衝 32 字做 meta / 重複前綴檢查。

## 風險

- Haiku 對中英語序差異的續句品質 → 允許等待、句群關閉強制補完、評測階段迭代 prompt；不行則預設維持 sentence 模式。
- 編排搬到 Rust 動到 session 寫入路徑 → sentence 模式保留原路徑，階段 3 兩種模式都驗收。
- Python 改動測試前先移走 `src-tauri/target/debug/stt_engine`（stale binary 陷阱）。
- OpenAI 15s 強制 commit 造成的 `pause` 其實在句中 → 句群提早關閉，譯文多一次斷句，可接受。

## 後續階段（不在本計畫）

- TTS：ElevenLabs Flash v2.5 每語言一條 WebSocket，吃本引擎的 append-only 譯文串流；落後控制迴路（精簡 / 摘要模式 + 1.1–1.2x 語速）。
- 廣播：LiveKit 每語言一條 audio track + data channel 字幕；聽眾網頁選語言。

## 階段 0 基線（2026-09-02，weather_90s.wav，gpt-live-transcribe + Haiku 4.5，`prototype/stream_bench.py`）

完整表格：`docs/bench/2026-09-02_stage0_stt_weather90.md`（STT 數字，修正 pacing 後）、`docs/bench/2026-09-02_stage0_translate_weather90_DRIFTED.md`（含翻譯；STT 欄位受 pacing bug 灌水，只取 TTFT 欄）。

| 指標 | P50 | P95 |
|---|---:|---:|
| 片段長度（字，n=49） | 10 | 15 |
| 片段落在 5–15 字 | 88% | |
| boundary 分佈 | clause 21 / forced 14 / sentence 11 / pause 3 | |
| **STT delta 落後**（字說出 → 字上螢幕，n=330） | **2,533 ms** | 3,671 ms |
| 片段 final 落後（最後一字說出 → final 到達） | 2,662 ms | 3,639 ms |
| 翻譯 TTFT（Haiku 4.5 streaming，n=46） | 662 ms | 1,052 ms |
| 推算：片段最後一字說出 → 譯文首字 | ≈ 3,300 ms | ≈ 4,700 ms |
| 推算：片段第一字說出 → 譯文首字 | ≈ 4,700 ms | ≈ 6,500 ms |

發現：
- **STT 是瓶頸**：gpt-live-transcribe 的 delta 落後語音 2.5s（程式舊註解寫 ~1.3s，不成立），單這一段就吃掉真人口譯 2–4s 的 EVS 預算。增量翻譯能省的是「等句尾」那 1–2s，改不了這 2.5s。要再往下只能換串流 STT（待評估）。
- gpt-live-transcribe 帶 `zh-tw` 提示仍輸出**簡體**（無 prompt 時）。對齊覆蓋率 69% 主因於此。待修：source=zh 時固定送一段繁體 `prompt`。
- 強制切（15 字）會切斷詞（「有發|展」「三|十一度」）；句級翻譯單獨翻這種片段會出錯，增量翻譯看的是整個句群源文，不受影響。
- 量測工具修了一個 bug：`audio_stream.wav_chunks` 相對 sleep 造成 90s 音訊花 97s 送完；已改絕對排程。
- Prefill 探測：Haiku 4.5 **接受 assistant prefill**，續句乾淨（" is about next year's budget allocation."）；標籤版在「動詞未到」案例會漏源文。兩版都不會主動「等待」，會猜動詞（「我們把第三季的行銷預算」→ "we're allocating…"）。階段 2 prompt 要改成「動詞未到時用主題前置句型（Regarding X, / As for X,）而非猜動詞」。

### 階段 0 補測：`delay` 等級與繁體 prompt（同一檔案，STT-only，各一輪）

官方 `delay` 有五級 minimal / low / medium / high / xhigh；app 目前用 `low`。

| 設定 | delta 落後 P50 / P95 | final 落後 P50 / P95 | 對齊覆蓋率 | 輸出字體 |
|---|---|---|---|---|
| low（現況） | 2,533 / 3,671 ms | 2,662 / 3,639 ms | 69% | 簡體 |
| **minimal** | **1,121 / 2,126 ms** | **1,342 / 1,763 ms** | 69% | 簡體 |
| minimal + 繁體 prompt | 1,619 / 2,243 ms | 1,715 / 2,173 ms | 87% | 繁體為主，零星簡體字（「闷热」） |

- `minimal` 比 `low` 少約 1.4 秒，對齊覆蓋率相同（粗略代表辨識品質沒有肉眼可見退化；n=1，階段 4 要用更多樣本驗 WER）。
- 繁體 prompt 大幅改善字體（覆蓋率 69% → 87%），但那一輪延遲高約 0.4s；單輪無法分辨是 prompt 造成還是網路波動，待重測。
- 報告：`docs/bench/2026-09-02_stage0_stt_weather90_minimal*.md`。
- 程式：`OpenAILiveTranscribeSTT(delay=...)` 參數已加（預設仍 `low`，未改 app 行為）；`stream_bench.py --delay/--prompt`。
