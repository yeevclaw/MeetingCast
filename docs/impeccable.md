# impeccable（UI 設計稽核 skill）— 安裝方式與安全說明

## 裝了什麼
- 來源：https://github.com/pbakaus/impeccable ，版本 **4.8.0**（tag `skill-v4.8.0`／`cli-v4.8.0`）
- 鎖定 commit：`414603bf14c7a344edb466bb1f85690c77ce8b7d`
- 授權：Apache-2.0（`third_party/impeccable/LICENSE`、`NOTICE.md`）
- 檔案（與上游該 commit 逐檔相同，未修改）：
  - `.claude/skills/impeccable/` ← 上游 `.claude/skills/impeccable/`（Claude Code 專案層 skill）
  - `.agents/skills/impeccable/` ← 上游 `.agents/skills/impeccable/`（Codex 專案層 skill）

## 為什麼用 vendor 而不是 git submodule
上游 repo 包含 Rust 引擎原始碼、demo、瀏覽器擴充等，整包 submodule 很大，而且 skill 必須放在 `.claude/skills/`、`.agents/skills/` 這兩個固定路徑才會被自動發現，submodule 做不到「一份放兩處」，得再加 symlink。
因此只 vendor 這兩個已建置好的 skill 資料夾（各約 2.3 MB），並在本文件記下 commit SHA。任何人都能用下面指令驗證沒有被改過：

```sh
git clone https://github.com/pbakaus/impeccable /tmp/impeccable && git -C /tmp/impeccable checkout 414603bf14c7a344edb466bb1f85690c77ce8b7d
diff -r /tmp/impeccable/.claude/skills/impeccable .claude/skills/impeccable
diff -r /tmp/impeccable/.agents/skills/impeccable .agents/skills/impeccable
```

升級：照同樣方式換成新 tag 的檔案，並更新本文件與 `THIRD_PARTY_NOTICES.md` 的 SHA。

## 刻意「沒有」裝的東西
- **沒有裝任何 hook**：沒有 `.claude/settings.json`／`settings.local.json` 的 SessionStart／PostToolUse／Stop hook，沒有 `.codex/hooks.json`，也沒有跑 `npx impeccable install`。上游的 hook 會在每次開 session、每次編輯、每次結束時自動執行引擎。要用就由人手動下指令。
- 沒有改任何全域設定（`~/.claude`、`~/.codex`、plugin marketplace）。
- `.gitignore` 從 `.claude/` 改成 `.claude/*` + `!.claude/skills/`：只追蹤 skill，`settings.local.json` 等本機設定仍不進版控。
- 引擎 binary（`scripts/bin/`）與執行期狀態（`.impeccable/`）不進版控。
- **請不要**執行 `/impeccable hooks on`。

## 引擎 binary 與網路
skill 的 `scripts/impeccable` 只是 launcher，實際檢查由 Rust 引擎（版本鎖在 `scripts/VERSION` = 0.1.18）執行。找不到引擎時，launcher 會從 GitHub Releases `engine-v0.1.18` 下載，並以 `scripts/engine-checksums.txt` 的 SHA-256 驗證，不符就拒絕執行（fail closed）。
建議離線使用：先手動下載並驗證，再用 `IMPECCABLE_BIN` 指向它：

```sh
curl -fsSLo impeccable https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.18/impeccable-darwin-arm64
grep darwin-arm64 .claude/skills/impeccable/scripts/engine-checksums.txt && shasum -a 256 impeccable   # 兩個值必須相同
chmod +x impeccable && export IMPECCABLE_BIN=$PWD/impeccable
```

## Telemetry（遙測）
檢查上游 4.8.0 原始碼的結果：
- 會連網回報的只有 `concept-seed` 的 roll／choice（`--chosen`）功能，打 impeccable.style 的 `/api/roll`、`/api/chosen`，並帶 `X-Impeccable-Client: impeccable/<版本>` header（`IMPECCABLE_TELEMETRY_CHANNEL` 只是給這個 header 加標籤）。
- `detect`（確定性規則）、`context` 等稽核指令只讀本機檔案或你指定的網址／DevTools port，不回報資料。`install`／`update`／`check` 會連 GitHub／impeccable.style 取更新，本專案不使用。
- 關閉方式：設 `DO_NOT_TRACK=1` 或 `IMPECCABLE_NO_TELEMETRY=1`（或 `impeccable telemetry off`）。關閉後 roll 仍可用，但會送 `X-Impeccable-Telemetry: off`，不送也不存任何遙測資料。

建議一律這樣跑：

```sh
export DO_NOT_TRACK=1 IMPECCABLE_NO_TELEMETRY=1
.claude/skills/impeccable/scripts/impeccable detect src            # 只做 regex 規則（.tsx/.css）
.claude/skills/impeccable/scripts/impeccable detect http://localhost:1420/   # 掃 dev server，規則較完整
```

## 怎麼用
在 Claude Code 輸入 `/impeccable audit`、`/impeccable critique`、`/impeccable polish <目標>`；在 Codex 用 `$impeccable`。注意：在瀏覽器直接開 dev server 時沒有 Tauri 環境，畫面需要 Tauri IPC mock 才會正常顯示。
