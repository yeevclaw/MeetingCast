// Cost figures shown in Settings when the user enables 同步口譯模式.
// Measured 2026-09-02 on the 90s demo clip (docs/PLAN_INCREMENTAL_INTERP.md,
// live run): incremental = 86 Haiku calls per 100s of speech for 2 targets,
// avg 818 input / 15 output tokens, prompt cache never engages (Haiku 4.5
// needs a 4,096-token prefix; ours is ~500) → ≈US$2.8 per hour of continuous
// speech. Sentence mode on the same clip = 38 calls (~600 in / ~40 out) ≈
// US$1.1. Both scaled to a typical hour with ~30 min of speech below.
export const INTERP_CALL_MULTIPLIER = "2–3 倍";
export const INTERP_COST_INCREASE = "+150%～+200%";
export const INTERP_COST_PER_HOUR_BEFORE_USD = "0.6";
export const INTERP_COST_PER_HOUR_AFTER_USD = "1.5";

export const OPENAI_DELAY_LEVELS: Array<{ id: string; label: string }> = [
  { id: "minimal", label: "minimal（最快，預設）" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh（最準、最慢）" },
];
