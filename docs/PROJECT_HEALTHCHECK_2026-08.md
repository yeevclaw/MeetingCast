# MeetingCast 專案健檢與恢復開發建議

> 健檢日期：2026-08-16  
> 基準版本：`v0.1.24`（commit `f214448`）  
> 目的：確認目前可運作範圍、找出恢復開發的阻塞，並規劃首次安裝、onboarding 與 OpenAI 能力的後續工作。
>
> 行動狀態：雲端 STT 遷移已完成並經使用者實測驗收，隨 v0.1.25 發佈。

## 1. 執行摘要

MeetingCast 的 React、Rust 核心邏輯與公開 macOS bundle 結構整體健康，但目前還不能宣稱「從全新 clone 到完整會議翻譯」已端到端通過：開發環境缺少可重現的 Python／sidecar 建置流程，而本次也未使用真實麥克風、API key 或下載約 1.6 GB 的語音模型。

目前最值得優先處理的不是大型重構，而是：

1. 先讓 fresh clone 可以用單一文件或腳本完成安裝、建置與測試。
2. 把首次啟動改為先說明並選擇 STT，再下載模型與要求麥克風權限。
3. 增加 CI、前端 onboarding 測試與乾淨 macOS 驗收清單。
4. 決定是否使用 Apple Developer ID／notarization，以及是否將 API key 遷移至 Keychain。
5. 雲端 STT 已遷移至官方現行首推的 `gpt-live-transcribe`；仍需以真實 API 做一次受控的 accuracy／latency／cost 驗收。

## 2. 已驗證狀態

### 2.1 Git 與版本

- 健檢開始時工作樹乾淨。
- `HEAD` 處於 detached 狀態，指向 `f214448`；此 commit 同時是本地／遠端 `main` 與 tag `v0.1.24`。
- GitHub 最新公開 release 是 `v0.1.24`，含 `MeetingCast_0.1.24_aarch64.dmg`。
- 恢復開發前應先建立或切換到明確分支，避免在 detached HEAD 上累積工作。

### 2.2 JavaScript／前端

- `pnpm install --frozen-lockfile` 成功。
- `pnpm build` 成功，TypeScript 與 Vite production build 均通過。
- 專案目前沒有 React component、Welcome wizard 或多視窗互動的自動測試。
- Node 26 可以完成建置，但會出現 `module.register()` deprecation warning；專案只寫「Node 20+」，未用 `engines`、`.node-version` 或同等機制固定受支援版本。

### 2.3 Rust／Tauri

- 普通 `cargo test` 會在 Tauri build script 階段失敗，原因是 `src-tauri/tauri.conf.json` 宣告的 `binaries/stt_engine-aarch64-apple-darwin` 不存在。
- 以一次性 `TAURI_CONFIG` 覆寫取消 `externalBin` 後，Rust 共 111 個測試全部通過（含本次新增的 glossary keywords 測試）。
- 這表示 Rust 業務邏輯目前健康，但測試入口不應依賴預先產生且被 gitignore 的 sidecar binary。

### 2.4 Python／STT

- Python 測試實際使用標準庫 `unittest`，不是 pytest；文件與操作指令應一致。
- 不載入 MLX／Torch 的 10 個 language registry 測試與 6 個 OpenAI session contract 測試通過。
- 其餘兩個 test module 因目前環境沒有 `mlx`、`torch` 而在 import 階段失敗，並非 assertion failure。
- 倉庫沒有 Python lockfile、dev/test dependency 群組或自動 bootstrap；`prototype/requirements.txt` 只有寬鬆下限，也沒有列出 PyInstaller。
- 打包腳本把 `python3.13/site-packages` 寫死；本機預設 Python 是 3.14，雖另有 3.13，但此設計容易在換機時失敗。

### 2.5 公開 macOS 安裝包

對公開的 `v0.1.24` DMG 做了只讀檢查：

- DMG CRC 驗證成功。
- `codesign --verify --deep --strict` 成功。
- 主程式與 `stt_engine` 都是 arm64、ad-hoc 簽章且啟用 hardened runtime。
- sidecar identifier 是 `com.tpisoftware.meetingcast.stt_engine`。
- sidecar 的五個必要 entitlement 均存在：audio input、disable library validation、unsigned executable memory、JIT、dyld environment variables。
- bundle 版本是 `0.1.24`，最低系統版本是 macOS 13。
- `spctl` 拒絕此 app；這與 ad-hoc、未 notarize 的發佈方式一致，也是 README 要求使用者執行 `xattr -cr` 的原因。

以上只能證明映像與簽章結構合理，不能取代真實乾淨 Mac 上的 Gatekeeper、麥克風、模型下載、API 翻譯與長時間錄音測試。

## 3. 已完成但尚未提交的低風險修復

健檢時發現 lockfile 中的 Vite 7.3.2 帶有 9 個相依套件安全警示，其中包含 5 個 high 與 2 個 moderate。已做以下相容版更新：

- `package.json`：`vite` 從 `^7.0.4` 調整為 `^7.3.5`。
- `pnpm-lock.yaml`：鎖定 Vite 7.3.5 與其修補後的相依版本。
- 更新後重新執行 `pnpm build`，成功。
- `pnpm audit` 降至 2 個 low，均位於開發工具鏈。

這兩個檔案目前是未提交變更；未 commit、未 push、未發佈。剩餘 low 警示需要 Vite 8／新版 React plugin 等 major upgrade，不應混入這次相容性修復。

## 4. 主要阻塞與風險

### P0：阻止可靠恢復開發

1. **Fresh clone 無法直接完成驗證**  
   缺少開發者安裝文件、Python lock、sidecar bootstrap 與不依賴 binary 的 Rust test 入口。

2. **沒有 CI 作為安全網**  
   目前無法在升級 Tauri、Vite、Python 套件或調整 onboarding 後快速確認三層仍相容。

3. **端到端硬體／網路驗證缺口**  
   尚需在乾淨 Apple Silicon Mac 驗證 Gatekeeper、麥克風權限、首次模型下載、兩種 STT、兩家 LLM、斷網重試與長時間錄音。

### P1：直接影響首次使用

1. **在使用者做選擇前就有高成本副作用**  
   Tauri setup 立即 spawn sidecar；sidecar 同時預熱本機模型與麥克風。因此即使使用者只想用 OpenAI cloud STT，也會下載約 1.6 GB、佔用 GPU／記憶體並觸發權限流程。

2. **安裝需要 Terminal**  
   ad-hoc bundle 被 `spctl` 拒絕。要求一般使用者執行 `xattr -cr` 會造成信任疑慮，也增加客服成本。

3. **API key 明文儲存**  
   Anthropic／OpenAI key 存在 `config.toml`。這對原型方便，但不適合作為長期桌面產品的預設。

4. **設定損壞時靜默回預設值**  
   TOML 讀取或解析失敗會直接使用 default config；使用者可能被當成首次使用者，卻不知道原設定已損壞，也沒有備份可恢復。

### P2：維護性與防禦深度

- `app.security.csp` 為 `null`，應依實際資源需求建立最小 CSP。
- 無 Welcome wizard、Settings、config migration 與三視窗事件的前端測試。
- 健檢時發現多份文件漂移；本次已同步 `CLAUDE.md`、`ARCHITECTURE.md` 與 `PROJECT_STRUCTURE.md` 的雲端 STT 與版本資訊，但 `PHASE1_GUIDE.md` 仍推薦已淘汰的 faster-whisper，需另行整理歷史文件定位。
- Python 相依多為無上限範圍。`mlx<0.21` 是已知 macOS 相容性限制，其他套件也應先建立可重現 lock 與相容性矩陣，再分批升級。

## 5. 首次安裝與 onboarding

### 5.1 現行實際流程

```text
下載 DMG
→ 拖入 Applications
→ 在 Terminal 執行 xattr -cr
→ 開啟 App
→ App 立即啟動 sidecar、下載／載入本機模型並探測麥克風
→ Welcome wizard 說明功能
→ 選 Anthropic 或 OpenAI，輸入 API key
→ 可在模型未完成時按「完成」
→ 回主畫面開始錄音
```

主要問題是「說明與選擇」晚於「下載、硬體權限與資源消耗」。畫面雖有進度與錯誤狀態，但使用者沒有在副作用發生前做知情選擇。

### 5.2 建議流程

```text
開啟 App
→ 歡迎與隱私說明
→ 選辨識方式：本機／OpenAI 雲端
→ 顯示該選項的下載量、隱私、費用與網路需求
→ 選來源語言與兩個目標語言
→ 選翻譯供應商並驗證 API key
→ 使用者確認後，才要求麥克風權限
→ 若選本機，才下載模型；提供取消、稍後下載與重試
→ 執行 5–10 秒試錄並顯示逐字稿／測試譯文
→ 完成並保存 onboarding 狀態
```

### 5.3 具體 UX 要求

- 清楚區分「語音辨識供應商」與「翻譯／摘要供應商」，避免兩個 OpenAI 用途混在同一把 key 的文案中。
- 本機模式顯示約 1.6 GB、預估時間、磁碟空間與「音訊不離開裝置」。
- 雲端模式顯示每分鐘成本、音訊會送至服務商、斷網限制與 idle auto-stop。
- 權限被拒時直接提供「開啟系統設定」與重新檢查，不讓 checklist 永久旋轉。
- 下載可取消、稍後繼續；模型未完成時不把主畫面呈現成已完全可用。
- onboarding 完成後仍能從 Settings 重跑「裝置與服務檢查」。
- 增加測試矩陣：全新使用者、已有 key 的升級使用者、跳過 key、無網路、無麥克風、模型下載中斷、雲端模式不下載本機模型。

## 6. OpenAI 近期模型／能力查核

### 6.1 「缺 state」可能指什麼

官方資料中沒有找到名為「缺 state」的模型或 API。由 MeetingCast 的需求與近期官方命名來看，較可能是以下概念之一，但仍需使用者確認原始詞：

1. **state／stateful conversation**：Responses API 的 `previous_response_id`，或 Conversations API 的持久 conversation object。
2. **`gpt-live-transcribe`**：官方 Realtime transcription 指引目前首推的低延遲轉錄模型；名稱可能在口述或記憶中被混淆。
3. **Agents SDK sessions／run state**：跨 agent run 保存上下文、恢復中斷流程的 session 能力。

以下評估只依官方文件所述能力，不把其中任何一項斷定為使用者原意。

### 6.2 已完成程式遷移，待受控 runtime 驗收

#### A. `gpt-live-transcribe` production 路徑

MeetingCast 的雲端 backend 已從 `gpt-realtime-whisper` 遷移至最新 Realtime transcription 指引首推的 `gpt-live-transcribe`。舊模型 ID 仍保留為程式內顯式 rollback seam，但不再是 production 預設。

`gpt-live-transcribe` 對 MeetingCast 的明確潛在效益：

- 支援 transcript delta 與 committed-turn completion，與目前 sidecar 事件模型相容。
- 支援 `prompt` 描述會議情境。
- 支援 `keywords`，可把啟用中的術語表直接當辨識提示；這正好改善目前 OpenAI cloud backend 無法注入 glossary 的缺點。
- 支援 `languages`，包括 `zh-tw` 等區域代碼，可比目前單一 `language: "zh"` 更貼近繁體中文需求。
- 支援 `delay` 取捨 latency／WER，可用現有 `docs/LATENCY.md` 方法做 P50／P95 比較。

程式已完成 session schema、`zh-tw`／ISO 語言提示、context prompt、canonical keyword sanitization 與離線測試。驗證結果為：前端 production build 通過、Rust 111 項測試通過、OpenAI session contract 6 項測試通過、Python compileall 通過。因真實 API 會計費，本次未發送請求；正式驗收仍需比較中文繁簡、專有名詞命中率、partial 穩定度、句尾延遲、每分鐘成本、斷線恢復，以及 zh/en/ja/vi 四種來源語言。

官方來源：

- [Realtime transcription 指引](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [`gpt-live-transcribe` 模型頁](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
- [`gpt-realtime-whisper` 模型頁](https://developers.openai.com/api/docs/models/gpt-realtime-whisper)

#### B. 保留既有 GPT-5.6 模型分工，先補量測

目前 `gpt-5.6-luna` 用於即時翻譯、`gpt-5.6-sol` 用於摘要；官方模型目錄確認兩者仍有效，並分別定位為成本敏感高流量與複雜工作負載。這個分工符合 MeetingCast 的「延遲／成本敏感翻譯 + 品質優先摘要」。

可立即做的是建立固定 eval dataset，量測翻譯首 token、術語遵循、錯誤語言率、摘要完整度與費用；目前沒有證據支持直接換模型。

官方來源：[OpenAI 模型目錄](https://developers.openai.com/api/docs/models)

### 6.3 需要產品與資料治理決策

#### A. Responses API／Conversations API 的持久 state

Responses API 可用 `previous_response_id` 做輕量延續；Conversations API 則可用 durable ID 跨 session、裝置或 job 保存 messages、tool calls 與 outputs。這適合未來的「針對某場會議繼續問答」、「追蹤決議與待辦」或跨次會議上下文。

但它不適合直接套在目前逐句即時翻譯：

- MeetingCast 已在 Rust 管理有限 rolling translation context，行為可控且 provider-neutral。
- `previous_response_id` 鏈中的既有 input tokens 仍會計費。
- Response 預設保存 30 天；conversation items 不受 30 天 TTL 限制。會議內容可能敏感，必須先決定 retention、刪除、同意、企業資料政策與 `store: false`／本機管理策略。
- 改用 OpenAI server-managed state 會削弱 Anthropic／OpenAI 雙 provider 的對稱性。

建議只有在確認要做「會後助理／跨回合問答」後，才設計獨立功能；不要把翻譯 pipeline 為了 state 而遷移。

官方來源：[Conversation state 指引](https://developers.openai.com/api/docs/guides/conversation-state)

#### B. `gpt-transcribe` 的跨 turn 轉錄上下文

官方說明 `gpt-transcribe` 在 Realtime transcription session 中會自動使用先前已轉錄 turns 作為 context，並能回傳偵測語言。但它的定位是 audio turn commit 後才開始轉錄，與 MeetingCast 重視的「邊講邊出字」不同。

只有在實測證明專有名詞與跨句一致性的收益高於額外延遲時才值得加入；可作為「準確優先雲端模式」，不應直接取代 live 模式。

官方來源：[Realtime transcription 指引](https://developers.openai.com/api/docs/guides/realtime-transcription)

#### C. `gpt-realtime-translate`

官方將它定位為 streaming speech-to-speech translation，會在來源音訊仍輸入時回傳翻譯音訊與 transcript deltas。若產品未來要讓參與者戴耳機聽同步口譯，可能很有價值。

目前 MeetingCast 的核心是兩個文字譯文視窗、兩個可配置目標語言、術語表、歷史紀錄與雙 LLM provider。導入此模型會改變產品輸出、音訊路由、成本與多目標 orchestration，必須先做產品決策，不能視為現有 pipeline 的單純升級。

官方來源：[`gpt-realtime-translate` 模型頁](https://developers.openai.com/api/docs/models/gpt-realtime-translate)

#### D. Agents SDK sessions／tracing／handoffs

Agents SDK 提供 session memory、tool loop、guardrails、handoffs 與 tracing。它適合未來把「會議摘要 → 決議萃取 → 任務建立 → 人工確認」做成代理式工作流。

目前 app 沒有外部工具操作或多 agent 協作需求，摘要也是單次請求；此時導入 SDK 只會增加 Python runtime、資料留存與錯誤面。若未來決定做會後 agent，應把它設計成獨立服務／模組，不要塞進職責為 STT 的 sidecar，並先定義人工確認與外部寫入邊界。

官方來源：

- [Agents SDK 概覽](https://openai.github.io/openai-agents-python/)
- [Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/)

### 6.4 目前無實際必要

- **`gpt-4o-transcribe-diarize`**：只適用 file transcription，Realtime transcription session 不支援 speaker labeling。MeetingCast 現有產品定義是單場單向、只處理主講者，因此現在沒有必要；若未來改成全會議、多講者紀錄才重新評估。
- **GPT-Realtime voice agent／`gpt-audio`／TTS**：產品目前不需要 AI 語音回應，增加播音還可能干擾麥克風與會議現場。
- **GPT-5.6 multi-agent、pro mode、programmatic tool calling**：即時翻譯與固定模板摘要沒有足夠複雜度，額外 latency／cost 不具可證明效益。
- **以 OpenAI state 取代本機 session 檔案**：目前歷史會議本機儲存已符合離線與隱私定位；沒有跨裝置同步需求前，不需要 server-side conversation persistence。

Speaker diarization 官方來源：[File transcription／Speaker diarization](https://developers.openai.com/api/docs/guides/speech-to-text#speaker-diarization)

## 7. 按優先級的落地計畫

### P0：1–2 天，先恢復可重現開發

1. 從 `main` 建立開發分支，再接收本文件與 Vite 修復。
2. 補 `DEVELOPMENT.md` 或 README developer section，明列 Node、pnpm、Rust、Python、Xcode CLI、PortAudio 與完整指令。
3. 固定 Node 與 Python 版本；建立 Python lock／constraints，分開 runtime、build、test dependencies。
4. 讓 `cargo test` 不依賴實體 sidecar binary，例如使用 test-specific Tauri config 或 build script 條件。
5. 建立單一 `check` 指令，依序跑 frozen install、frontend build、Rust tests、Python unittest。
6. 加最小 CI，先鎖住目前已通過的組合。

### P1：3–5 天，修首次啟動

1. 將 sidecar spawn、模型下載與 mic probe 從 Tauri setup 移到使用者確認後。
2. onboarding 增加 STT 選擇、下載／隱私／成本說明、語言選擇與試錄。
3. 本機／cloud 分流：cloud 不下載本機模型；local 不要求 OpenAI key。
4. 加取消、重試、稍後下載、權限重新檢查與 config corruption recovery。
5. 對 Welcome wizard 與 config migration 加 component／integration tests。

### P1：雲端 STT runtime 驗收

1. 用受控 API key 跑 `gpt-live-transcribe` benchmark，不使用正式會議資料。
2. 驗證 active glossary 的 sanitized `keywords` 與 context prompt 實際被接受，並確認 `zh-tw`／en／ja／vi 語言提示。
3. 與 rollback seam `gpt-realtime-whisper`、local mlx 在同一批音檔上比較 accuracy、latency、cost。
4. 若新模型未達標，使用顯式舊模型 seam 回退；不要改變 local 預設。

### P2：1–2 週，發布與安全

1. 決定並導入 Developer ID signing + notarization，消除 Terminal 安裝步驟。
2. 將 API key 遷移至 macOS Keychain，設計舊明文 key 的一次性 migration／刪除策略。
3. 設定最小 CSP。
4. 設定檔解析失敗時保留原檔、顯示可理解錯誤並提供恢復路徑。
5. 建立乾淨 macOS release acceptance checklist。

### P3：有明確需求後

- 若要會後互動問答，再評估 Responses／Conversations state。
- 若要自動建立任務或寄送結果，再評估 Agents SDK 與 human-in-the-loop。
- 若要多人完整會議紀錄，再評估 file diarization。
- 每次只升一組 major dependency，透過 CI 與 latency／quality eval 驗證。

## 8. 需要使用者決策

1. 第一次啟動的預設 STT 是本機還是雲端？是否允許未確認就下載約 1.6 GB？
2. 是否要保留「單一主講者、單向翻譯」定位，或擴展成多人完整會議助理？
3. 是否願意使用 Apple Developer Program／Developer ID 進行 notarization？
4. API key 是否遷移至 Keychain？舊 `config.toml` 明文 key 要自動移除、保留備份，還是要求使用者重新輸入？
5. 會議逐字稿是否允許送往 OpenAI 並由 Responses／Conversations 保存？所需 retention、刪除與企業合規政策為何？
6. 「缺 state」的原始詞或來源是什麼？是 conversation state、`gpt-live-transcribe`、Agents session，還是其他正式名稱？
7. 是否希望提供同步語音翻譯，還是繼續只做文字投影？這會決定 `gpt-realtime-translate` 是否值得試驗。

## 9. 建議的完成定義

MeetingCast 可視為「已恢復可持續開發」需同時滿足：

- fresh clone 依文件一次完成安裝。
- CI 固定通過 frontend、Rust、Python 三層。
- `cargo test` 不需手工準備 sidecar binary。
- local 與 cloud STT 都有可重複 benchmark。
- 乾淨 Mac 完成安裝、權限、模型下載、錄音、雙語翻譯、歷史與摘要驗收。
- onboarding 不在使用者確認前下載大型模型或要求敏感權限。
- release 安裝不要求一般使用者執行 Terminal 指令，或產品明確接受此限制。
