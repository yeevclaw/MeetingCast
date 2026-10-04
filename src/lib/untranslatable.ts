/**
 * Input with nothing to translate: no letter or digit at all (pure
 * punctuation / symbols), or one character repeated 20+ times in a row (the
 * Whisper silence failure, e.g. 「示示示…」). Mirrors `is_untranslatable` in
 * src-tauri/src/translator.rs — the model, given such input, writes
 * placeholders like 「(空字串)」 instead of nothing.
 */
export function isUntranslatable(text: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  let run = 0;
  let prev = "";
  for (const c of text.replace(/\s/g, "")) {
    run = c === prev ? run + 1 : 1;
    if (run >= 20) return true;
    prev = c;
  }
  return false;
}
