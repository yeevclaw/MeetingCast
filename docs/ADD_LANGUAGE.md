# 新增語言 SOP（ADD_LANGUAGE）

> MeetingCast 的語言支援由**單一登錄表** `shared/languages.json` 驅動：Rust `include_str!`、TypeScript `import`、Python（`checks.py` / `run_eval.py`）三端讀同一份。加一個語言的**主體是補登錄表一筆**，加上少數幾個「per-language 但沒有 registry 化」的 code-side 點。UI 元件（控制 / 譯文 / 設定 / 歷史 / 術語表）全部 registry-driven，加語言**不需要動**——這是本文件末尾的驗收斷言。

本文件語向命名以語言 `code`（`zh` / `en` / `ja` / `vi`）表示；新增語言在下文以 `NEW` 代稱。嚴格照順序做，**每一步都有對應的自動守門或手動驗收**。

---

## 前置：先判斷「新語言用哪個 script profile」

`script_profile` 決定 wrong-language 判定（清空明顯譯錯語言的整段譯文，是管線唯一破壞性動作）。目前有三個：

| profile | 適用 | 判「譯錯語言」的規則（`verify.rs` = `checks.py` 逐字同義） |
|---|---|---|
| `latin` | en / vi | `(han+kana)/total > 0.5` |
| `han` | zh | `latin/total > 0.5 且 han/total < 0.1`；或 `kana/total > 0.3` |
| `japanese` | ja | `latin/total > 0.5 且 (han+kana)/total < 0.1`；或 `total ≥ 20 且 kana == 0 且 han/total > 0.5` |

（字元域：han = U+4E00–9FFF ∪ U+3400–4DBF、kana = U+3040–309F ∪ U+30A0–30FF、latin = ASCII 英文字母；全規則先過「最短 8 非空白字」守門。）

- **新語言若能歸入現有 profile**（例：西班牙文 → `latin`）→ 不必動判定邏輯。
- **新語言若需要新書寫系統**（例：韓文諺文、泰文、阿拉伯文）→ 必須在**同一個 commit**同時新增 `verify.rs::wrong_language` 與 `checks.py::is_wrong_language` 的 profile 分支（見步驟 4 的**parity 契約**）。

哲學：**寧可漏抓不可誤殺**。新 profile 的閾值請往寬鬆設，並靠 `traces.jsonl` 的 `translation_wrong_language` 事件事後調參。

---

## 10 步檢查表

### 1. `shared/languages.json` 補一筆

在陣列**依 UI 顯示順序**插入該語言一筆，下列 8 個字串欄位全部非空 + `empty_state` 物件：

| 欄位 | 說明 |
|---|---|
| `code` | 語言代碼（與 whisper 慣例一致） |
| `native_name` | 原生名（譯文視窗標題用） |
| `zh_ui_name` | 繁中 UI 名（設定/歷史下拉、chip 用） |
| `prompt_name` | 翻譯 system prompt 的目標語言名（如 `Japanese (日本語)`） |
| `whisper_code` | Whisper 的語言 code（pin mlx-whisper / OpenAI Realtime 解碼） |
| `script_profile` | `latin` \| `han` \| `japanese`（或前置步驟新增的 profile） |
| `carrier` | Whisper `initial_prompt` 術語載句，**必含 `{terms}` 佔位** |
| `term_join` | carrier 內術語串接分隔字（拉丁語系 `", "`、CJK `、`） |
| `empty_state` | `{waiting, hint}`，該語言**原文**（譯文視窗待機提示） |

**`carrier` / `empty_state` / `native_name` 務必請母語者過目**——這些字串會直接顯示給該語言使用者。

### 2. `prototype/stt/lang_resources.py` 補防禁表

Whisper 餵靜音/雜訊會外洩訓練資料片語（YouTube outro、字幕致謝），且**語言相關**。新增：

- 一個 `HALLUCINATIONS_NEW = (...)` tuple（該語言的 outro / 訂閱 / 致謝片語，小寫）
- 在 `_PER_LANGUAGE` map 補 `"NEW": HALLUCINATIONS_NEW`

`hallucination_blocklist(lang)` = `COMMON + EN + per-lang`（英文 outro 在任何語言 pin 下都會外洩，故恆含）。

### 3. golden 案例 ≥ 6 條

在 `prototype/eval/golden/translation_cases.jsonl` **append**（既有案例一字不改），至少涵蓋：new↔zh、new↔en、一條 hallucination（rule 6 重複字元 → `expect.empty`）、一條 glossary（`glossary` 帶 `translations` map）。schema：`source_lang` + `source` + `targets` + `expect`（支援 `empty` / `non_empty` / `contains` / `not_contains` / `max_cjk_ratio`）。

### 4. 新 script system → `verify.rs` + `checks.py`（**parity 契約**）

**僅當前置步驟判定需要新 profile 時**。在**同一個 commit**內同步兩處，逐字同義：

- `src-tauri/src/verify.rs::wrong_language`（新增 profile 分支）
- `prototype/eval/checks.py::is_wrong_language`（新增同樣的分支）

兩邊漂移就是 bug——`checks.py` 的自我檢查（`python eval/checks.py`）與既有單元測試會抓部分，但語意等價要靠人審。若沿用現有 profile，本步跳過。

### 5. 跑單元測試

```bash
cd prototype && .venv/bin/python -m unittest discover -s ../tests/python
```

`tests/python/test_language_registry.py` 是**登錄表機器守門**：自動檢查恰四（或 N）語、code 唯一、9 欄非空、`carrier` 含 `{terms}`、`script_profile` 合法、`empty_state.waiting/hint` 非空。新語言若欄位漏填或 profile 打錯，這裡就會紅。

（若新增了語言總數，記得同步更新 `test_language_registry.py` 的 `EXPECTED_CODES`。）

### 6. 離線 eval（成本 gate）

```bash
cd prototype
.venv/bin/python eval/run_eval.py --dry-run --source NEW --targets zh,en   # 免費，看 rendered prompt
.venv/bin/python eval/run_eval.py --yes --source NEW --targets zh,en       # 實跑，會計費
```

`--dry-run` 印成本估算 + 前 2 筆 request body 後 `exit`，**保證不碰網路**；確認 system prompt 第一行的 `{source_lang}` 渲染正確、glossary 區塊有帶術語，再實跑。實跑前**務必先估算並取得同意**（每 call ~500 in / ~100 out token）。

### 7. 手動端到端流程（dev）

⚠️ 先閃 stale sidecar：`mv src-tauri/target/debug/stt_engine{,.bak}`。走一輪：**設定選 NEW 為來源** → 錄音 → NEW 逐字稿 + 目標槽位譯文（防禁不誤殺）→ History 出現 NEW chip → 產生總結 → GlossaryModal 開一本 `source_lang = NEW` 的術語書。

### 8. `README.md` 語言表更新

更新 README 管線描述的「源語言集合」與技術棧表，把 NEW 納入。

### 9. code-side per-language 必改點（**registry 沒涵蓋的三處**）

總結標題 / 投影片標題 / meta 防漏**不是** registry-driven，是 `translator.rs` 的寫死 match arm，加語言要補：

| 位置 | 補什麼 |
|---|---|
| `translator.rs::template_headings` | 5 個總結模板（exec_brief / minutes / discussion / decision_log / client_call）的 NEW 語言 H2 標題向量 |
| `translator.rs::build_slide_outline_system` | slide_outline 的 NEW 四元組（表紙 / 議程 / 決定事項 / 次步驟 對應詞） |
| `translator.rs::META_MARKERS`（＋`checks.py::META_MARKERS`，同步！） | NEW 語言的「破格 meta 回覆」片語群（掃描頭 32 字用）；刻意**不含**中文源常見開場道歉會合法譯出的詞 |

`translator.rs` 有測試斷言五模板 × 全語言皆 `Some` 且段數正確（`template_headings_every_arm_present_with_expected_count`），漏補會紅。翻譯目標名走 registry `prompt_name`（`target_lang_name` 未知 target 回 `None` → 硬 Err，不會靜默 fallback 英文），這部分**不用**動。

### 10. 驗收斷言：UI 元件零改動

加語言後，下列元件**必須零改動**仍正確支援 NEW（它們一律讀 `src/lib/languages.ts` / `config.language`，不寫死語言）：

- `src/main.tsx`（label→slot 路由，語言由 config runtime 解析，不綁 label）
- `src/windows/ControlWindow.tsx`（`effective_targets` 驅動 pending/finalize/translate）
- `src/windows/TranslationWindow.tsx`（`target_slots[slotIndex]` 解析 → `nativeName` setTitle → 訂閱 `translation:*:{lang}` → `emptyState` 佔位）
- `src/components/SettingsModal.tsx`（來源/槽位 select 從 `LANGS` + `selectLabel` 生成）
- `src/components/HistoryModal.tsx`（逐字稿 v2 `translations` map + `LANGS` 動態總結 tab）
- `src/components/GlossaryModal.tsx`（`translations` map 多語譯名輸入）

Rust 端同理：`languages.rs`（`all()` / `get()` / `is_valid()`）、`config.rs`（`LanguageConfig` / `effective_targets` / `sanitize_language`）皆 registry-driven。**若上述任一元件需要為 NEW 改 code，代表有硬編碼漏網，應回頭 registry 化，而不是在元件補特例。**

---

## 已知限制

- **無 auto-detect**：源語言為手動選。Whisper 回傳的 `result["language"]`（偵測語言）已存在但刻意不讀（協定 `detect_language` 欄位預留 `false`）；未來 auto-detect 走 local Whisper。
- **手動關閉的譯文視窗需重啟 App 才恢復**：slot 設「不使用」會顯示佔位（不隱藏視窗——隱藏後不可發現且無法恢復）；但使用者手動關掉 t1/t2 視窗後，目前需重啟才會重開。
