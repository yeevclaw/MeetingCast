import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AudioDevice, Config } from "@/lib/types";
import { LANGS, selectLabel, zhName } from "@/lib/languages";

const MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6"];
const SUMMARY_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5"];
const OPENAI_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra"];
const OPENAI_SUMMARY_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra"];

// 每小時翻譯費用概估（顯示在 option 文字）。假設：雙譯文視窗、每小時
// ~30 分鐘語音（~300 句 utterance × 2 目標 ≈ 0.48M input / 0.024M output
// tokens）、無 prompt cache。定價（2026-07 官方牌價 per 1M tokens）：
//   claude-haiku-4-5 $1/$5、claude-sonnet-4-6 $3/$15、
//   gpt-5.6-luna $1/$6、gpt-5.6-terra $2.5/$15、gpt-5.6-sol $5/$30。
// 換 model 或官方調價時同步更新這兩張表。
// 另：辨識引擎選項的費用標示（openai realtime-whisper $0.017/分鐘音訊，
// 一小時會議依 30–60 分鐘計費音訊估 ≈US$0.5–1）寫在「辨識引擎」select
// 的 option 文字，調價時一併更新。
const TRANSLATE_COST_PER_HOUR: Record<string, string> = {
  "claude-haiku-4-5": "0.6",
  "claude-sonnet-4-6": "1.8",
  "gpt-5.6-luna": "0.6",
  "gpt-5.6-terra": "1.6",
};

// 每次總結費用概估（一小時會議逐字稿 ≈ 5k input / 1.5k output tokens）。
const SUMMARY_COST_PER_RUN: Record<string, string> = {
  "claude-sonnet-4-6": "0.04",
  "claude-haiku-4-5": "0.01",
  "gpt-5.6-sol": "0.07",
  "gpt-5.6-terra": "0.04",
};

function translateModelLabel(m: string): string {
  const cost = TRANSLATE_COST_PER_HOUR[m];
  return cost ? `${m}（≈US$${cost}/小時）` : m;
}

function summaryModelLabel(m: string): string {
  const cost = SUMMARY_COST_PER_RUN[m];
  return cost ? `${m}（≈US$${cost}/次）` : m;
}

// Kept in sync with HistoryModal's SUMMARY_TEMPLATES labels (not exported
// there). If the template set changes, update both.
const SUMMARY_TEMPLATES: Array<{ id: string; label: string }> = [
  { id: "exec_brief", label: "AI 智能總結" },
  { id: "minutes", label: "會議記錄" },
  { id: "discussion", label: "討論 / 腦力激盪" },
  { id: "decision_log", label: "決策推理" },
  { id: "client_call", label: "客戶 / 銷售會議" },
  { id: "slide_outline", label: "簡報重點" },
];

// Summary target languages, derived from the shared registry so adding a
// language surfaces it here automatically. Labels are the 繁中 UI names
// (中文 / 英文 / 日文 / 越南文).
const SUMMARY_TARGETS: Array<{ id: string; label: string }> = LANGS.map((l) => ({
  id: l.code,
  label: zhName(l.code),
}));

type Backend = "local" | "openai";

// Language <option>s for a translation-slot select. A code is disabled (with
// an explanatory title) when it equals the source language or is already used
// by the other slot, so the same language can't drive both windows.
function slotOptions(source: string, otherSlot: string, otherName: "一" | "二") {
  return LANGS.map((l) => {
    const sameAsSource = l.code === source;
    const usedByOther = otherSlot !== "" && l.code === otherSlot;
    return (
      <option
        key={l.code}
        value={l.code}
        disabled={sameAsSource || usedByOther}
        title={
          sameAsSource
            ? "與來源語言相同"
            : usedByOther
              ? `已用於譯文視窗${otherName}`
              : undefined
        }
      >
        {selectLabel(l.code)}
      </option>
    );
  });
}

export default function SettingsModal({
  onClose,
  backend,
  setBackend,
  useMic,
  setUseMic,
  running,
}: {
  onClose: () => void;
  backend: Backend;
  setBackend: (b: Backend) => void;
  useMic: boolean;
  setUseMic: (v: boolean) => void;
  running: boolean;
}) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showOpenai, setShowOpenai] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [devices, setDevices] = useState<AudioDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  // Transient note shown when picking a new source language collides with a
  // translation slot and we auto-swap that slot to the old source. Cleared on
  // the next language change or on save.
  const [swapNote, setSwapNote] = useState<string | null>(null);
  // Which translation-slot windows the user has manually closed (null on
  // getByLabel). An enabled slot with a closed window can't show translations
  // until the app restarts — surfaced as a warning under that field.
  const [closedSlots, setClosedSlots] = useState<{ t1: boolean; t2: boolean }>({
    t1: false,
    t2: false,
  });
  // Dedup concurrent refreshes — without this, React StrictMode's double-
  // mount fires two list_audio_devices in flight simultaneously, the second
  // overwrites the first's oneshot in the Rust side, and the first call
  // surfaces a spurious "sidecar dropped response" even though devices
  // ultimately come back fine.
  const refreshInFlightRef = useRef(false);

  const refreshDevices = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setRefreshingDevices(true);
    try {
      const list = await invoke<AudioDevice[]>("list_audio_devices");
      setDevices(list);
      setDevicesError(null);
    } catch (e) {
      setDevicesError(String(e));
      setDevices([]);
    } finally {
      refreshInFlightRef.current = false;
      setRefreshingDevices(false);
    }
  }, []);

  useEffect(() => {
    invoke<Config>("get_config")
      .then(setCfg)
      .catch((e) => setError(`load: ${e}`));
    getVersion().then(setVersion).catch(() => {});
    refreshDevices();
  }, [refreshDevices]);

  // Detect translation windows the user has closed by hand. StrictMode double-
  // mounts this effect; the cancelled flag drops the stale run's setState.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [w1, w2] = await Promise.all([
        WebviewWindow.getByLabel("t1"),
        WebviewWindow.getByLabel("t2"),
      ]);
      if (!cancelled) setClosedSlots({ t1: w1 === null, t2: w2 === null });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!cfg) return;
    setSaving(true);
    setError(null);
    setSwapNote(null);
    try {
      await invoke("set_config", { config: cfg });
      onClose();
    } catch (e) {
      setError(`save: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  function update(patch: Partial<Config["api"]>) {
    if (!cfg) return;
    setCfg({ ...cfg, api: { ...cfg.api, ...patch } });
  }

  function updateAudio(patch: Partial<Config["audio"]>) {
    if (!cfg) return;
    setCfg({ ...cfg, audio: { ...cfg.audio, ...patch } });
  }

  function updateIdleMinutes(v: number) {
    if (!cfg) return;
    setCfg({ ...cfg, idle_auto_stop_minutes: v });
  }

  function updateSummary(patch: Partial<Config["summary"]>) {
    if (!cfg) return;
    setCfg({ ...cfg, summary: { ...cfg.summary, ...patch } });
  }

  // Pick a new source language. If it collides with an existing translation
  // slot, auto-swap that slot to the OLD source (the slots are always distinct
  // and never equal the source, so this can't produce a duplicate) and leave a
  // transient note explaining the swap.
  function handleSourceChange(newSource: string) {
    if (!cfg || newSource === cfg.language.source) return;
    const oldSource = cfg.language.source;
    const slots = [...cfg.language.target_slots];
    let note: string | null = null;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === newSource) {
        slots[i] = oldSource;
        note = `已自動將譯文視窗${i === 0 ? "一" : "二"}改為${zhName(oldSource)}（原設定與來源語言相同）`;
      }
    }
    setSwapNote(note);
    setCfg({ ...cfg, language: { source: newSource, target_slots: slots } });
  }

  function handleSlotChange(idx: number, value: string) {
    if (!cfg) return;
    setSwapNote(null);
    const slots = [...cfg.language.target_slots];
    slots[idx] = value;
    setCfg({ ...cfg, language: { ...cfg.language, target_slots: slots } });
  }

  return (
    <div className="absolute inset-0 z-10 flex items-stretch justify-center bg-paper-900/30 p-4">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-lg border border-paper-200 bg-white shadow-xl">
        <header className="flex flex-shrink-0 items-center justify-between border-b border-paper-200 px-5 py-3">
          <h2 className="text-lg font-semibold">設定</h2>
          <button
            className="text-paper-500 hover:text-paper-900"
            onClick={onClose}
            aria-label="關閉"
          >
            ✕
          </button>
        </header>

        {!cfg ? (
          <p className="px-5 py-6 text-sm text-paper-600">載入中…</p>
        ) : (
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
            <Field
              label="翻譯引擎（LLM）"
              hint="翻譯與總結使用的服務；openai 模式下與雲端辨識共用同一把 OpenAI key"
            >
              <select
                className="w-full rounded border border-paper-300 px-2 py-1"
                value={cfg.api.provider === "openai" ? "openai" : "anthropic"}
                onChange={(e) => update({ provider: e.target.value })}
              >
                <option value="anthropic">anthropic (Claude，預設)</option>
                <option value="openai">openai (GPT)</option>
              </select>
            </Field>

            <Field
              label="Anthropic API key"
              hint="從 console.anthropic.com 建立；provider 為 anthropic 時必填"
            >
              <div className="flex gap-2">
                <input
                  type={showAnthropic ? "text" : "password"}
                  className="flex-1 rounded border border-paper-300 px-2 py-1 font-mono text-xs"
                  value={cfg.api.anthropic_api_key}
                  onChange={(e) => update({ anthropic_api_key: e.target.value })}
                  placeholder="sk-ant-api03-..."
                />
                <button
                  className="rounded border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100"
                  onClick={() => setShowAnthropic(!showAnthropic)}
                >
                  {showAnthropic ? "隱藏" : "顯示"}
                </button>
              </div>
            </Field>

            <Field
              label="OpenAI API key"
              hint="openai 翻譯引擎或 openai 辨識 backend 使用；platform.openai.com/api-keys"
            >
              <div className="flex gap-2">
                <input
                  type={showOpenai ? "text" : "password"}
                  className="flex-1 rounded border border-paper-300 px-2 py-1 font-mono text-xs"
                  value={cfg.api.openai_api_key}
                  onChange={(e) => update({ openai_api_key: e.target.value })}
                  placeholder="（可留空）"
                />
                <button
                  className="rounded border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100"
                  onClick={() => setShowOpenai(!showOpenai)}
                >
                  {showOpenai ? "隱藏" : "顯示"}
                </button>
              </div>
            </Field>

            <Field
              label="翻譯模型"
              hint="費用為概估：兩個譯文視窗、每小時約 30 分鐘語音"
            >
              <select
                className="w-full rounded border border-paper-300 px-2 py-1"
                value={cfg.api.provider === "openai" ? cfg.api.openai_model : cfg.api.model}
                onChange={(e) =>
                  update(
                    cfg.api.provider === "openai"
                      ? { openai_model: e.target.value }
                      : { model: e.target.value },
                  )
                }
              >
                {(cfg.api.provider === "openai" ? OPENAI_MODELS : MODELS).map((m) => (
                  <option key={m} value={m}>
                    {translateModelLabel(m)}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="總結模型"
              hint={
                cfg.api.provider === "openai"
                  ? "會議紀錄的 AI 總結使用；預設 gpt-5.6-sol，費用為一小時會議的單次概估"
                  : "會議紀錄的 AI 總結使用；預設 Sonnet 4.6，費用為一小時會議的單次概估"
              }
            >
              <select
                className="w-full rounded border border-paper-300 px-2 py-1"
                value={
                  cfg.api.provider === "openai"
                    ? cfg.api.openai_summary_model
                    : cfg.api.summary_model
                }
                onChange={(e) =>
                  update(
                    cfg.api.provider === "openai"
                      ? { openai_summary_model: e.target.value }
                      : { summary_model: e.target.value },
                  )
                }
              >
                {(cfg.api.provider === "openai" ? OPENAI_SUMMARY_MODELS : SUMMARY_MODELS).map(
                  (m) => (
                    <option key={m} value={m}>
                      {summaryModelLabel(m)}
                    </option>
                  ),
                )}
              </select>
            </Field>

            <Field
              label="來源語言"
              hint={
                running
                  ? "錄音中無法變更語言，請先停止"
                  : "你在會議中說的語言；變更後於下次開始錄音生效"
              }
            >
              <select
                className="w-full rounded border border-paper-300 px-2 py-1 disabled:opacity-50"
                value={cfg.language.source}
                onChange={(e) => handleSourceChange(e.target.value)}
                disabled={running}
              >
                {LANGS.filter((l) => l.source_capable).map((l) => (
                  <option key={l.code} value={l.code}>
                    {selectLabel(l.code)}
                  </option>
                ))}
              </select>
              {swapNote && (
                <p className="mt-2 rounded border border-warn-200 bg-warn-50 px-2 py-1.5 text-xs text-warn-900">
                  {swapNote}
                </p>
              )}
            </Field>

            <Field label="譯文視窗一">
              <select
                className="w-full rounded border border-paper-300 px-2 py-1 disabled:opacity-50"
                value={cfg.language.target_slots[0]}
                onChange={(e) => handleSlotChange(0, e.target.value)}
                disabled={running}
              >
                {slotOptions(cfg.language.source, cfg.language.target_slots[1], "二")}
              </select>
              {cfg.language.target_slots[0] !== "" && closedSlots.t1 && (
                <p className="mt-1 text-xs text-warn-700">
                  譯文視窗已被手動關閉，重新啟動 App 後才會重新出現
                </p>
              )}
            </Field>

            <Field label="譯文視窗二" hint="設為「不使用」可只留一個譯文視窗">
              <select
                className="w-full rounded border border-paper-300 px-2 py-1 disabled:opacity-50"
                value={cfg.language.target_slots[1]}
                onChange={(e) => handleSlotChange(1, e.target.value)}
                disabled={running}
              >
                <option value="">不使用</option>
                {slotOptions(cfg.language.source, cfg.language.target_slots[0], "一")}
              </select>
              {cfg.language.target_slots[1] !== "" && closedSlots.t2 && (
                <p className="mt-1 text-xs text-warn-700">
                  譯文視窗已被手動關閉，重新啟動 App 後才會重新出現
                </p>
              )}
            </Field>

            <Field
              label="辨識引擎"
              hint={
                running
                  ? "錄音中無法切換，請先停止"
                  : "預設 mlx-whisper（免費、離線可用）；openai 需填 API key"
              }
            >
              <select
                className="w-full rounded border border-paper-300 px-2 py-1 disabled:opacity-50"
                value={backend}
                onChange={(e) => setBackend(e.target.value as Backend)}
                disabled={running}
              >
                <option value="local">local (mlx-whisper)（免費，本機運算）</option>
                <option value="openai">openai (realtime-whisper)（≈US$0.5–1/小時）</option>
              </select>
              {backend === "openai" && (
                <p className="mt-2 rounded border border-warn-200 bg-warn-50 px-2 py-1.5 text-xs text-warn-900">
                  ⚠ OpenAI Realtime Whisper 不支援術語表注入；來源語言為中文時只會輸出簡體字。
                  優點：邊講邊出字（live captioning）、技術詞彙準確度較佳。
                </p>
              )}
            </Field>

            <Field
              label="音源"
              hint={running ? "錄音中無法切換，請先停止" : "預設使用麥克風；取消勾選則跑 weather demo"}
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-paper-900 disabled:opacity-50"
                  checked={useMic}
                  onChange={(e) => setUseMic(e.target.checked)}
                  disabled={running}
                />
                使用麥克風
              </label>
            </Field>

            {useMic && (
              <Field
                label="麥克風裝置"
                hint={
                  running
                    ? "錄音中無法切換，請先停止"
                    : "拔插藍芽耳機或外接麥克風後可按 ↻ 重新整理"
                }
              >
                <div className="flex gap-2">
                  <select
                    className="flex-1 rounded border border-paper-300 px-2 py-1 disabled:opacity-50"
                    value={cfg.audio.input_device}
                    onChange={(e) => updateAudio({ input_device: e.target.value })}
                    disabled={running}
                  >
                    <option value="">系統預設</option>
                    {/* 已選裝置目前不在清單中（被拔掉了）— 仍保留為選項，
                        標 "(未連接)" 提示，避免儲存時被靜默清掉。 */}
                    {cfg.audio.input_device &&
                      !(devices ?? []).some((d) => d.name === cfg.audio.input_device) && (
                        <option value={cfg.audio.input_device}>
                          {cfg.audio.input_device}（未連接）
                        </option>
                      )}
                    {(devices ?? []).map((d) => (
                      <option key={d.name} value={d.name}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100 disabled:opacity-50"
                    onClick={refreshDevices}
                    disabled={refreshingDevices || running}
                    aria-label="重新整理裝置清單"
                    title="重新整理"
                  >
                    {refreshingDevices ? "…" : "↻"}
                  </button>
                </div>
                {devicesError && (
                  <p className="mt-1 break-all text-xs text-danger-700">
                    無法列出裝置：{devicesError}
                  </p>
                )}
              </Field>
            )}

            <Field
              label="閒置自動停止（分鐘）"
              hint="超過設定分鐘無人說話則自動停止，避免 OpenAI 雲端方案空轉計費；0 = 停用"
            >
              <input
                type="number"
                min={0}
                max={120}
                step={1}
                className="w-24 rounded border border-paper-300 px-2 py-1"
                value={cfg.idle_auto_stop_minutes}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateIdleMinutes(Number.isFinite(v) && v >= 0 ? v : 0);
                }}
              />
            </Field>

            <Field
              label="會後自動總結"
              hint="錄音結束後自動用 AI 產生總結，完成後於歷史紀錄查看"
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-paper-900"
                  checked={cfg.summary.auto_generate}
                  onChange={(e) => updateSummary({ auto_generate: e.target.checked })}
                />
                錄音結束後自動產生總結
              </label>

              {cfg.summary.auto_generate && (
                <div className="mt-3 space-y-3 border-l-2 border-paper-200 pl-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-paper-700">
                      總結模板
                    </label>
                    <select
                      className="w-full rounded border border-paper-300 px-2 py-1"
                      value={cfg.summary.auto_template}
                      onChange={(e) => updateSummary({ auto_template: e.target.value })}
                    >
                      {SUMMARY_TEMPLATES.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-paper-700">
                      產生語言
                    </label>
                    <div className="flex flex-wrap gap-3">
                      {SUMMARY_TARGETS.map((t) => {
                        const checked = cfg.summary.auto_targets.includes(t.id);
                        return (
                          <label
                            key={t.id}
                            className="flex cursor-pointer items-center gap-1.5 text-sm text-paper-700"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer accent-paper-900"
                              checked={checked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...cfg.summary.auto_targets, t.id]
                                  : cfg.summary.auto_targets.filter((x) => x !== t.id);
                                updateSummary({ auto_targets: next });
                              }}
                            />
                            {t.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <p className="text-xs text-paper-500">
                    每個語言各呼叫一次總結模型 API（與手動產生總結相同）
                  </p>
                </div>
              )}
            </Field>

            <Field label="檔案">
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded border border-paper-300 px-2 py-1 text-xs text-paper-700 hover:bg-paper-100"
                  onClick={() => invoke("open_config_folder").catch((e) => setError(`open: ${e}`))}
                  type="button"
                >
                  📂 設定資料夾
                </button>
                <button
                  className="rounded border border-paper-300 px-2 py-1 text-xs text-paper-700 hover:bg-paper-100"
                  onClick={() => invoke("open_errors_log").catch((e) => setError(`open: ${e}`))}
                  type="button"
                >
                  📝 錯誤紀錄
                </button>
              </div>
            </Field>
          </div>
        )}

        {error && (
          <p className="mx-5 mb-2 rounded bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</p>
        )}

        <footer className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-paper-200 px-5 py-3">
          <span className="text-[11px] tabular-nums text-paper-500">
            {version ? `MeetingCast v${version}` : ""}
          </span>
          <div className="flex gap-2">
            <button
              className="rounded px-3 py-1.5 text-sm text-paper-600 hover:bg-paper-100"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="rounded bg-paper-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-paper-700 disabled:bg-paper-400"
              onClick={handleSave}
              disabled={!cfg || saving}
            >
              {saving ? "儲存中…" : "儲存"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-paper-700">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-paper-500">{hint}</p>}
    </div>
  );
}
