/**
 * Map raw backend error strings into user-friendly Chinese messages.
 * Falls back to the raw string if no rule matches, so we never lose detail.
 *
 * The "raw" message is preserved as a tooltip / details so power users can
 * still see the underlying error.
 */

export type FriendlyError = {
  primary: string;
  secondary?: string;
  raw: string;
};

const RULES: Array<{ test: RegExp; map: (m: RegExpMatchArray) => Omit<FriendlyError, "raw"> }> = [
  {
    test: /Anthropic API key not configured/i,
    map: () => ({
      primary: "尚未設定 Anthropic API key",
      secondary: "請點右上角「設定」填入金鑰",
    }),
  },
  {
    test: /anthropic 401/,
    map: () => ({
      primary: "Anthropic API key 無效或已過期",
      secondary: "請在「設定」確認金鑰是否正確",
    }),
  },
  {
    test: /anthropic 403/,
    map: () => ({
      primary: "Anthropic API 拒絕存取",
      secondary: "金鑰可能沒有此模型的權限，請到 console.anthropic.com 確認",
    }),
  },
  {
    test: /模型 id 無效/,
    map: () => ({
      primary: "模型 id 無效或已下架",
      secondary: "請在設定確認翻譯/總結模型名稱",
    }),
  },
  {
    test: /anthropic 429/,
    map: () => ({
      primary: "Anthropic API 觸及配額限制",
      secondary: "稍後再試，或到 console.anthropic.com 加額度",
    }),
  },
  {
    test: /anthropic 5\d\d/,
    map: () => ({
      primary: "Anthropic API 暫時故障",
      secondary: "稍候再試一次",
    }),
  },
  {
    test: /python venv not found/,
    map: () => ({
      primary: "找不到 Python 環境",
      secondary: "Dev 環境需要 prototype/.venv；請依 README 建立",
    }),
  },
  {
    test: /sidecar script not found/,
    map: () => ({
      primary: "辨識引擎檔案遺失",
      secondary: "請重新安裝 app",
    }),
  },
  {
    test: /spawn sidecar/,
    map: () => ({
      primary: "辨識引擎啟動失敗",
      secondary: "請查看「設定 → 錯誤紀錄」",
    }),
  },
  {
    test: /request failed|reqwest|dns|network|connection/i,
    map: () => ({
      primary: "翻譯請求失敗",
      secondary: "網路連線異常或被防火牆擋住",
    }),
  },
];

export function friendly(raw: string): FriendlyError {
  for (const rule of RULES) {
    const m = raw.match(rule.test);
    if (m) {
      return { ...rule.map(m), raw };
    }
  }
  return { primary: raw, raw };
}
