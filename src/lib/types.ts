// A language code from the shared registry (zh / en / ja / vi / …). Widened
// from the old "en" | "vi" union now that source + target languages are
// configurable; runtime validity is enforced against the registry.
export type Lang = string;

export type TranscriptPayload = {
  type: "transcript";
  text: string;
  is_final: boolean;
  t_start: number;
  t_end: number;
};

export type Source =
  | { type: "mic"; device?: string }
  | { type: "wav"; path: string };

export type ChunkPayload = {
  id: string;
  text: string;
};

export type DonePayload = {
  id: string;
};

export type AudioDevice = {
  name: string;
  channels: number;
};

export type GlossaryEntry = {
  term: string;
  aliases: string[];
  // v2: per-language translations keyed by registry code. Always present from
  // the backend (empty map when the term has no translations); GlossaryModal
  // is the sole construction site and always emits it.
  translations: Record<string, string>;
  // Legacy target mirrors, still read when folding a pre-v2 entry into the map
  // (and kept for 0.1.x downgrade compatibility). Derived from `translations`
  // server-side on save, so the UI no longer writes them.
  en?: string;
  vi?: string;
};

export type GlossaryBook = {
  name: string;
  // Source language the book's `term`s are authored in. Always present from
  // the backend (serde default zh); GlossaryModal fills it on every save.
  source_lang: string;
  entries: GlossaryEntry[];
};

export type Config = {
  api: {
    anthropic_api_key: string;
    openai_api_key: string;
    model: string;
    summary_model: string;
  };
  audio: {
    input_device: string;
  };
  language: {
    source: string;
    // Always length 2 — one per translation window slot; "" = slot disabled.
    target_slots: string[];
  };
  glossaries: GlossaryBook[];
  active_glossary: string | null;
  idle_auto_stop_minutes: number;
  onboarding_complete: boolean;
  summary: {
    auto_generate: boolean;
    auto_template: string;
    auto_targets: string[];
  };
};

// transcript.jsonl row (schema v2) as delivered by get_session_transcript.
// Rust folds legacy {zh,en,vi} rows into src/translations on read, but the
// optional legacy mirrors are kept so a component mid-migration can still read
// them — normalizeStored() (HistoryModal) accepts either shape.
export type StoredUtterance = {
  id?: string;
  t_start: number;
  t_end: number;
  src: string;
  translations: Record<string, string>;
  incomplete?: boolean;
  // Reserved for auto-detect mode (Whisper-detected language); omitted today.
  lang?: string;
  // ---- Legacy v1 mirrors: present only when reading a pre-v2 row. ----
  zh?: string;
  en?: string;
  vi?: string;
};

export type SessionMeta = {
  session_id: string;
  started_at: string;
  ended_at?: string | null;
  duration_secs: number;
  backend: string;
  language: string;
  device: string;
  count: number;
  incomplete_count: number;
  // Registry codes of every summary.{code}.md on disk (v2). Optional so pre-v2
  // meta.json (which lacks the field) still parses; Rust backfills it on read.
  has_summaries?: string[];
  has_summary_zh: boolean;
  has_summary_en: boolean;
  has_summary_vi: boolean;
};
