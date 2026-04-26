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

export type Source = { type: "mic" } | { type: "wav"; path: string };

export type ChunkPayload = {
  id: string;
  text: string;
};

export type DonePayload = {
  id: string;
};

export type Config = {
  api: {
    anthropic_api_key: string;
    deepgram_api_key: string;
    model: string;
  };
};
