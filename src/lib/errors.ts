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
  /** Suggested one-click fix. "account" = the key is missing / rejected →
   *  open 設定 → 帳號. Absent when there is no obvious fix. */
  action?: "account";
};

/** Rust returns this prefix from translate / interp while the network probe
 *  says we're offline (src-tauri/src/netcheck.rs). It's a pause, not a fault:
 *  callers skip the error card and let the 網路 chip + window banner speak. */
export const OFFLINE_PREFIX = "offline:";
export function isOfflineError(raw: unknown): boolean {
  return String(raw).startsWith(OFFLINE_PREFIX);
}

const RULES: Array<{ test: RegExp; map: (m: RegExpMatchArray) => Omit<FriendlyError, "raw"> }> = [
  // ---- Resource / environment faults first: they often arrive wrapped in a
  // generic "setup failed: …" / "stt error: …" prefix, and the specific cause
  // is the actionable part. ----
  {
    test: /No space left on device|Errno 28|ENOSPC|disk (is )?full/i,
    map: () => ({
      primary: "磁碟空間不足",
      secondary: "語音模型約需 2 GB；清出空間後按「重新啟動引擎」重試",
    }),
  },
  {
    test: /huggingface|hf_hub|HfHub|hf\.co\b|LocalEntryNotFound|snapshot_download/i,
    map: () => ({
      primary: "語音模型下載失敗",
      secondary: "公司網路可能擋 huggingface.co；改用手機熱點後重試，或先切到雲端辨識",
    }),
  },
  {
    test: /PortAudio|InputStream|Invalid (input )?device|Error querying device|No (default )?input device|device unavailable/i,
    map: () => ({
      primary: "無法開啟麥克風",
      secondary: "確認麥克風已接上並已授權 MeetingCast；或在右欄「本場設定」換一支麥克風",
    }),
  },
  {
    test: /^offline:/,
    map: () => ({
      primary: "目前沒有網路，翻譯已暫停",
      secondary: "逐字稿照常進行；網路恢復後新的句子會自動翻譯",
    }),
  },
  {
    test: /Anthropic API key not configured/i,
    map: () => ({
      primary: "尚未設定 Anthropic API key",
      secondary: "請點右上角「設定」填入金鑰",
      action: "account",
    }),
  },
  {
    test: /anthropic 401/,
    map: () => ({
      primary: "Anthropic API key 無效或已過期",
      secondary: "請在「設定」確認金鑰是否正確",
      action: "account",
    }),
  },
  {
    test: /anthropic 403/,
    map: () => ({
      primary: "Anthropic API 拒絕存取",
      secondary: "金鑰可能沒有此模型的權限，請到 console.anthropic.com 確認",
      action: "account",
    }),
  },
  {
    test: /模型 id 無效/,
    map: () => ({
      primary: "模型 id 無效或已下架",
      secondary: "請在設定確認翻譯/總結模型名稱",
      action: "account",
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
    test: /OpenAI API key not configured/i,
    map: () => ({
      primary: "尚未設定 OpenAI API key",
      secondary: "請點右上角「設定」填入金鑰",
      action: "account",
    }),
  },
  {
    test: /openai 401/,
    map: () => ({
      primary: "OpenAI API key 無效或已過期",
      secondary: "請在「設定」確認金鑰是否正確",
      action: "account",
    }),
  },
  {
    test: /openai 403/,
    map: () => ({
      primary: "OpenAI API 拒絕存取",
      secondary: "金鑰可能沒有此模型的權限，請到 platform.openai.com 確認",
      action: "account",
    }),
  },
  {
    test: /openai 429/,
    map: () => ({
      primary: "OpenAI API 觸及配額限制",
      secondary: "稍後再試，或到 platform.openai.com 檢查額度",
    }),
  },
  {
    test: /openai 5\d\d/,
    map: () => ({
      primary: "OpenAI API 暫時故障",
      secondary: "稍候再試一次",
    }),
  },
  // OpenAI Python SDK style (cloud STT inside the sidecar): "… status_code=401 …".
  {
    test: /status_code[=:]\s*401|Incorrect API key|invalid_api_key/i,
    map: () => ({
      primary: "OpenAI API key 無效或已過期",
      secondary: "雲端辨識無法連線；請到「設定 → 帳號」確認金鑰",
      action: "account",
    }),
  },
  {
    test: /status_code[=:]\s*403/i,
    map: () => ({
      primary: "OpenAI API 拒絕存取",
      secondary: "金鑰可能沒有雲端辨識模型的權限，請到 platform.openai.com 確認",
      action: "account",
    }),
  },
  {
    test: /status_code[=:]\s*429|insufficient_quota|rate_limit/i,
    map: () => ({
      primary: "OpenAI API 觸及配額或速率限制",
      secondary: "稍後再試，或到 platform.openai.com 檢查額度",
    }),
  },
  {
    test: /status_code[=:]\s*5\d\d/i,
    map: () => ({
      primary: "OpenAI 服務暫時故障",
      secondary: "稍候再試一次；現場可先切到本機辨識",
    }),
  },
  {
    test: /first[ _-]?token|timed? ?out|timeout|逾時/i,
    map: () => ({
      primary: "服務回應逾時",
      secondary: "網路或服務太慢；下一句會自動再試，持續發生請檢查網路",
    }),
  },
  {
    test: /setup failed/i,
    map: () => ({
      primary: "辨識引擎初始化失敗",
      secondary: "請按「重新啟動引擎」；持續發生請查看「設定 → 進階 → 錯誤紀錄」",
    }),
  },
  {
    test: /stt error/i,
    map: () => ({
      primary: "辨識過程發生錯誤",
      secondary: "可再按一次開始；持續發生請查看「設定 → 進階 → 錯誤紀錄」",
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
      primary: "連線失敗",
      secondary: "網路連線異常或被防火牆擋住",
    }),
  },
];

/**
 * `fallback` is the headline used when no rule matches (e.g. "無法開始錄音");
 * the raw text then becomes the secondary line instead of the headline.
 */
export function friendly(raw: unknown, fallback?: string): FriendlyError {
  const text = String(raw);
  for (const rule of RULES) {
    const m = text.match(rule.test);
    if (m) {
      return { ...rule.map(m), raw: text };
    }
  }
  return fallback ? { primary: fallback, secondary: text, raw: text } : { primary: text, raw: text };
}
