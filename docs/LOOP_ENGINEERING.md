# MeetingCast Loop Engineering 設計記錄

> 這一輪（`feature/ux-loop-engineering`）把「hill-climbing 持續改進迴圈」工程化：分層韌性、deterministic 驗證、事件驅動、traces + 離線 eval。核心原則是**先量測再優化**——這輪只鋪 instrumentation 與工具，不動任何 threshold。資料流與訊息協定的全貌見 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 1. 四個 loop level 對應本專案

把「讓系統可持續改進」拆成四層：從單次呼叫要能撐住（L1），到不花錢的守門（L2），到狀態用事件流動（L3），到留痕可離線回放評分（L4）。

| Level | 意義 | 這輪落地了什麼 | 關鍵檔案 |
|---|---|---|---|
| **L1 呼叫韌性** | 單次 API / 子程序呼叫要能抗暫時性失敗 | 全域共用 reqwest client + connect/read timeout；bounded retry（250 / 750 ms）涵蓋 transport 失敗與 429 / 500 / 503 / 529，並 honor `Retry-After`；SSE 中斷後 non-streaming 補打一次並 emit `translation:replace`；summary 斷流 restart 一次 | `src-tauri/src/translator.rs`（`post_anthropic_with_retry` / `translate_once_nonstreaming` / `consume_*_stream`） |
| **L2 deterministic 驗證** | 不花額外 LLM 呼叫，純字串 / 數值邏輯守門 | glossary 命中檢查、wrong-language 判定、summary H2 結構 / slide 張數檢查；STT 端 4 層 hallucination gate（RMS floor → consistency → segment confidence → known-phrase + single-char dominance）。全部 observe-only 不改寫輸出，唯一例外是 wrong-language：清空明顯錯語言的整段譯文 | `src-tauri/src/verify.rs`、`prototype/stt/local.py`、`prototype/eval/checks.py` |
| **L3 事件驅動** | 狀態變化以事件傳遞，UI 與後端解耦 | line-delimited JSON over stdio 的 sidecar 協定；Tauri event（`transcript` / `translation:chunk\|done\|replace` / `summary:chunk\|done\|verify\|error\|restart` / `prewarm\|model_loading\|model_ready`）；STT gate skip 改走 `on_diag` callback 轉成結構化 diag 事件（CLI 沒注入時退回 stderr） | `src-tauri/src/sidecar.rs`、`python-sidecar/stt_engine.py`、`prototype/stt/local.py`（`on_diag` 注入點） |
| **L4 traces + eval** | 每次呼叫都留痕，離線可回放評分 | `TraceRecord` 每次 Anthropic 呼叫一筆（latency / token / cache / stop_reason / outcome / glossary_violations）；`stt_diag` 每次 gate skip 一筆；離線 golden-set eval CLI（`run_eval.py`）＋ parity checks（`checks.py`）＋ gate 單元測試 | `src-tauri/src/traces.rs`、`prototype/eval/`、`tests/python/` |

---

## 2. traces.jsonl schema 與「先量測再優化」

**位置**：`~/Library/Application Support/MeetingCast/traces.jsonl`（與 `errors.log` 同目錄）。JSON-lines、append-only，超過 10 MB 輪替成 `traces.jsonl.1`（只保留一份前檔，policy 與 errors.log 相同）。兩種 record 共用同一檔案，靠 `kind` 欄位區分讀取。與 `errors.log` 的差別：traces 記**每一次**呼叫（含成功），errors 只記失敗。

**TraceRecord**（`kind` = `translate` | `summary`）：

| 欄位 | 意義 |
|---|---|
| `ts` | 呼叫結束的 RFC3339 時間 |
| `kind` | `translate` / `summary` |
| `id` | utterance id（translate，等於 `t_start` 字串）或 session id（summary） |
| `target` | `en` / `vi` / `zh` |
| `model` | 實際送出的 model id |
| `ttft_ms` | 首個 `content_block_delta` 的時間；`None` 表示沒 stream 出內容（欄位省略） |
| `total_ms` | 從送出到結束的 wall-clock |
| `input_tokens` / `output_tokens` | usage token 數 |
| `cache_creation_input_tokens` / `cache_read_input_tokens` | prompt cache 活動 |
| `stop_reason` | `end_turn` / `max_tokens` / … |
| `retries` | 重試次數（0 = 一次成功） |
| `outcome` | `ok` / `error` / `filtered` / `empty` |
| `glossary_violations` | 源含術語但譯文缺對應譯法的清單（observe-only）；無則省略 |

**stt_diag record**（`kind` = `stt_diag`）：`gate`（`min_speech` / `rms_floor` / `consistency` / `segment_confidence` / `hallucination_phrase` / `single_char_dominance`）、`t_start`（gate 知道時才有）、`detail`（觸發的數字，**不含任何音訊資料**）。observe-only，純供離線 gate 調參，不進 UI。

**先量測再優化**：現在什麼 threshold 都還沒動。這輪的目的是先把每一路的 latency / token / cache 命中 / gate skip 記成資料，累積幾場真實會議後，再用資料決定要改什麼。沒有資料就調參數是瞎猜。

**prompt cache 的疑慮（2048-token 門檻）**：Anthropic Haiku 系列的 prompt caching 有 **2048-token 最小門檻**，system prompt 低於門檻就不會被 cache。目前 translate 的 system prompt（9 條規則 + 術語表區塊）估計仍低於 2048 token，所以 `cache_read_input_tokens` 很可能**恆為 0**。判斷方式：跑幾場會議後看 traces.jsonl 的 `cache_read_input_tokens`——若確實恆為 0，代表沒吃到 cache。屆時再權衡：是把 prompt 補到門檻以上（多半得不償失，還會拉高每次 input token），還是接受無 cache（prompt 本來就不長，重複輸入成本有限）。**先量測，別現在猜**。

---

## 3. 決策記錄

- **不設 temperature**：新版 Claude 模型移除了取樣參數。translate / summary 的 request body 與 eval CLI 都刻意不帶 `temperature`；硬塞會被 API 拒。
- **wrong-language 閾值 0.5 + 最短 8 非空白字**：plan 原本浮動 40%，最後定 `> 50%` 且加最短長度守門。理由：rule 3 要保留專有名詞原文（公司 / 產品 / 人名），一句合法的英文或越南文譯句本來就會夾幾個漢字；**誤殺一句真譯文比漏抓一句假中文更糟**，寧可漏抓不可誤殺。`checks.py` 的 `is_wrong_language` 與 `verify.rs` 的 `wrong_language` 保持同語意（同門檻、同 CJK 範圍）。
- **`summary_model` 進 config**：主翻譯用 Haiku（延遲優先），總結用 Sonnet（結構化輸出品質高於 Haiku）。兩者都在 `config.toml [api]` 的 `model` / `summary_model` 可改，不寫死在程式裡（`config.rs` 有 `default_summary_model` fallback）。
- **`WHISPER_MODEL_TOTAL_BYTES` 釘 revision**：下載進度百分比用一個實測的 total bytes（`mlx-community/whisper-large-v3-turbo` revision `a4aaeec…`，1,613,979,798 bytes）。這值綁定特定 revision，未來若重新量化上傳會漂掉；但它**只用來算進度條百分比**，漂了頂多讀數略偏、不影響功能——接受這個 tradeoff，不做動態量測。
- **語言登錄表是單一事實來源**：多語化後 script profile、翻譯 prompt 名、deepgram/whisper code、術語 carrier 句、empty_state 全部集中在 `shared/languages.json` 一份，Rust `include_str!`、TS `import`、Python（`checks.py` / `run_eval.py`）各自讀同一份，避免三端各自寫死漂移。加語言＝補一筆，見 `docs/ADD_LANGUAGE.md`。
- **script-profile wrong-language 規則集（registry 驅動）**：上一條的 0.5 門檻只涵蓋「源＝中文、目標＝英/越」。多語化後 `wrong_language` 不再假設語向，改依每語言在登錄表標的 `script_profile`（`latin` | `han` | `japanese`）分支判定，`verify.rs` 與 `checks.py` **逐字同義**。字元域：han = U+4E00–9FFF ∪ U+3400–4DBF、kana = U+3040–309F ∪ U+30A0–30FF、latin = ASCII 英文字母；全規則先過「最短 8 非空白字」守門：
  - **latin（en/vi）**：`(han+kana)/total > 0.5` → 判錯（加 kana 才抓得到「停在日文沒翻成英/越」；純中文回覆無 kana，對舊 zh→en/vi 行為零變化）
  - **japanese（ja）**：`latin/total > 0.5 且 (han+kana)/total < 0.1` → 判錯（英文回覆）。`< 0.1` 這條刻意寬鬆，保護「MeetingCastとGoogle Slidesを統合します」這類夾英文專名的合法日文。**再加** `total ≥ 20 且 kana == 0 且 han/total > 0.5` → 判錯（20+ 字零假名＝中文回覆，正常日文長句必含助詞假名）
  - **han（zh）**：`latin/total > 0.5 且 han/total < 0.1` → 判錯（英/越回覆）；或 `kana/total > 0.3` → 判錯（日文回覆）
  哲學不變：**寧可漏抓不可誤殺**（清空整段是管線唯一破壞性動作），每筆判錯都寫 `traces.jsonl` 供日後調閾值。

---

## 4. 設計保留（deferred）

以下每項都想過但這輪刻意不做，記下問題 / 構想 / 觸發條件，等資料或需求成熟再動。

- **summary map-reduce 分段**
  問題：超長逐字稿一次總結會撞 `max_tokens` 或 context window。
  構想：先分段 map 出小結，再 reduce 成最終總結。
  觸發：traces 出現 summary 的 `stop_reason = max_tokens`。

- **meta-filter 命中自動重試**
  問題：Claude 偶爾破格輸出 meta 說明，現在直接丟棄（使用者看到空白）。
  構想：命中 meta 時自動重打一次（可搭配一句更強的 system 提醒）。
  觸發：traces 的 `filtered` 率 > 1%。

- **LLM-as-judge summary grader**
  問題：summary 品質目前只有 deterministic 結構檢查，內容好壞沒有量化。
  構想：opt-in，用 Haiku 當 judge 打分，約 $0.02/次。
  觸發：需先做成本 UI（讓使用者知道並同意這筆額外花費）才能開。

- **incomplete utterance 補譯佇列**
  問題：VAD 8s 強制切片可能把一句話切兩半，後半句缺前文語境。
  構想：偵測未完句，排入佇列等下一片段合併補譯。
  風險：涉及已寫入 session transcript 的檔案改寫，風險高，獨立版本再做。

- **audio_capture bounded queue + drop-oldest + diag**
  問題：STT 若慢於進音，audio queue 可能無上限成長。
  構想：改 bounded queue，滿了丟最舊並記一筆 diag。
  觸發：長會議出現記憶體 / 延遲異常，或 diag 顯示 backlog。

- **背景 post-session eval → eval.json**
  問題：會議結束後沒有自動的品質回顧。
  構想：session 結束在背景跑一輪 deterministic eval，結果寫進 session 目錄的 `eval.json`。
  觸發：traces / diag 資料量夠，想把離線 eval 自動化進 app。

- **glossary 詞條挖掘**
  問題：術語表得使用者手動一條條建。
  構想：從逐字稿用 n-gram / jieba 挖高頻未知詞，在 GlossaryModal 開一個「建議」tab。
  觸發：術語表使用率高、使用者反映建表麻煩。

---

## 5. Eval 工具使用方式

### run_eval.py（cwd = `prototype/`）

```bash
# 只看成本估算 + 前 2 筆 rendered request body，不碰網路（先跑這個）
.venv/bin/python eval/run_eval.py --dry-run

# 實跑：先印估算，再互動確認 y/N
.venv/bin/python eval/run_eval.py

# CI / 無互動（會真的花錢）
.venv/bin/python eval/run_eval.py --yes
```

- **成本 gate**：每次都先印 `n_calls`（cases × targets）、model、估算 token（~500 in / ~100 out per call）、估算 USD。`--dry-run` 印完就 `exit`，保證不碰網路；無 `--yes` 會 `input()` 問你，非 `y` 一律 abort。
- **`--prompt-file` A/B 流程**：預設指向 `src-tauri/prompts/translate_system.txt`（唯一真相來源，與 Rust `include_str!` 同一檔）。改 prompt 時，複製一份成候選，`--prompt-file path/to/candidate.txt` 跑同一 golden set，比對兩次的 pass/fail 與失敗 category。
- **golden set**：`prototype/eval/golden/translation_cases.jsonl`，39 條。schema 為 `source_lang`（省略＝`zh`）＋ `source`（源文；舊 case 沿用 `zh` 欄相容）＋ per-case `targets`，`glossary` 走 v2 `translations` map（舊 `en`/`vi` 欄 fallback）。前 25 條 zh→en/vi（9 條 prompt 規則 + 術語表 + 一般會議句），後 14 條為 ja↔zh/en、zh→ja、en→ja 煙霧案例（glossary / context / 專名 / rule6 重複 / rule7-8 meta 各覆蓋）。`run_eval.py --source <code>` 設定缺 `source_lang` 之 case 的預設源語言，per-case `source_lang` 覆蓋之。
- **parity**：`checks.py` 的驗證與 `src-tauri/src/verify.rs`、`translator.rs` 的 `META_MARKERS` 保持同語意——**改任一邊要同步另一邊**。
- **回歸 gate**：任何 case fail 會 non-zero exit。輸出寫 `results/<timestamp>.jsonl`（已 gitignore）。

### tests/python（cwd = `prototype/`）

```bash
.venv/bin/python -m unittest discover -s ../tests/python
```

pytest 不在 `prototype/.venv` 內，故用 stdlib `unittest` 免裝依賴。涵蓋 `stt/local.py` 的 hallucination gate（known-phrase / single-char dominance / segment-confidence 過濾）與 `eval/checks.py` 的 parity 函式。
