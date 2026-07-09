import registry from "../../shared/languages.json";

/** One language row from the shared registry (`shared/languages.json`). Same
 *  source of truth Rust (`languages.rs`) and Python read; keep this interface
 *  in lockstep with the JSON field set. */
export interface LangInfo {
  code: string;
  native_name: string;
  zh_ui_name: string;
  prompt_name: string;
  deepgram_code: string;
  whisper_code: string;
  script_profile: string;
  carrier: string;
  term_join: string;
  empty_state: { waiting: string; hint: string };
}

/** All languages in registry (UI display) order: zh → en → ja → vi. */
export const LANGS: LangInfo[] = registry as LangInfo[];

/** Language codes in registry order. */
export const LANG_CODES: string[] = LANGS.map((l) => l.code);

/** Registry row for a code, or undefined if the code isn't registered. */
export function langInfo(code: string): LangInfo | undefined {
  return LANGS.find((l) => l.code === code);
}

/** Traditional-Chinese UI name (e.g. "英文"). Falls back to the raw code. */
export function zhName(code: string): string {
  return langInfo(code)?.zh_ui_name ?? code;
}

/** Native endonym (e.g. "English", "日本語"). Falls back to the raw code. */
export function nativeName(code: string): string {
  return langInfo(code)?.native_name ?? code;
}

/** Label for a language <select> option: the zh UI name, plus the native name
 *  in parentheses when they differ (e.g. "英文（English）", but just "中文…"
 *  never collapses since zh_ui_name≠native_name for every row). */
export function selectLabel(code: string): string {
  const info = langInfo(code);
  if (!info) return code;
  return info.zh_ui_name === info.native_name
    ? info.zh_ui_name
    : `${info.zh_ui_name}（${info.native_name}）`;
}

/** Empty-state strings for a translation window. Unknown codes fall back to
 *  English so the window never renders blank. */
export function emptyState(code: string): LangInfo["empty_state"] {
  const info = langInfo(code) ?? langInfo("en");
  return info!.empty_state;
}
