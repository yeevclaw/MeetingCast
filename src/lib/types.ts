export type Lang = "en" | "vi";

export type Utterance = {
  id: string;
  zh: string;
  en: string;
  vi: string;
};

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
  en: string;
  vi: string;
};

export type GlossaryBook = {
  name: string;
  entries: GlossaryEntry[];
};

export type Config = {
  api: {
    anthropic_api_key: string;
    deepgram_api_key: string;
    openai_api_key: string;
    model: string;
  };
  audio: {
    input_device: string;
  };
  glossaries: GlossaryBook[];
  active_glossary: string | null;
};

export type StoredUtterance = {
  id: string;
  t_start: number;
  t_end: number;
  zh: string;
  en: string;
  vi: string;
  incomplete: boolean;
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
  has_summary_zh: boolean;
  has_summary_en: boolean;
  has_summary_vi: boolean;
};
