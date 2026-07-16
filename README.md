# MeetingCast

即時會議翻譯助手 — 你發言，即時轉寫並並行翻譯到兩個可配置的譯文視窗，供外籍同仁閱讀。來源語言：中／英／日／越；譯文語言：中／英／日／越／柬（柬埔寨文僅能當譯文目標）。

## 系統需求

- macOS 13+（Apple Silicon）
- 麥克風
- Anthropic API key（[申請](https://console.anthropic.com/)）

## 安裝

1. 從 [Releases](https://github.com/yeevclaw/MeetingCast/releases) 下載 `MeetingCast_<version>_aarch64.dmg`
2. 開啟 dmg，把 `MeetingCast.app` 拖到 `Applications`
3. Ad-hoc 簽章，經瀏覽器 / Slack / Email 下載會被加 quarantine，開啟前需在 Terminal 跑：
   ```bash
   xattr -cr /Applications/MeetingCast.app
   ```
   （AirDrop / USB 傳的不需要）
4. 雙擊開啟，首次啟動會下載語音模型（~1.6 GB）並跳出麥克風授權對話框，按允許
5. 在 Welcome wizard 填入 Anthropic API key

## 使用

1. 按「開始錄音」或快捷鍵 `⌘+Shift+M`
2. 用設定的來源語言發言，講完一句停頓後自動送出翻譯
3. 兩個譯文視窗同步顯示各自目標語言的譯文，可拖到外接螢幕
4. 按「停止錄音」結束，紀錄自動存檔
5. 右上角 history icon 可查看歷史會議、產生 AI 總結、匯出 Markdown
