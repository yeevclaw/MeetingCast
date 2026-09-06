import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { AudioDevice, Config } from "@/lib/types";
import { LANGS, selectLabel, zhName } from "@/lib/languages";
import {
  INTERP_CALL_MULTIPLIER,
  INTERP_COST_INCREASE,
  INTERP_COST_PER_HOUR_AFTER_USD,
  INTERP_COST_PER_HOUR_BEFORE_USD,
  OPENAI_DELAY_LEVELS,
  SUMMARY_COST_PER_RUN,
  TRANSLATE_COST_PER_HOUR,
} from "@/lib/cost";
import { isSlotWindowOpen, openSlotWindow, type SlotLabel } from "@/lib/windows";

const MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6"];
const SUMMARY_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5"];
const OPENAI_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra"];
const OPENAI_SUMMARY_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra"];

// 費用概估數字集中在 src/lib/cost.ts（換 model 或官方調價時改那裡）。
function translateModelLabel(m: string): string {
  const cost = TRANSLATE_COST_PER_HOUR[m];
  return cost != null ? `${m}（≈US$${cost}/小時）` : m;
}

function summaryModelLabel(m: string): string {
  const cost = SUMMARY_COST_PER_RUN[m];
  return cost != null ? `${m}（≈US$${cost}/次）` : m;
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
// language surfaces it here automatically.
const SUMMARY_TARGETS: Array<{ id: string; label: string }> = LANGS.map((l) => ({
  id: l.code,
  label: zhName(l.code),
}));

type Backend = "local" | "openai";
export type SettingsTab = "meeting" | "account" | "advanced";

const TABS: Array<{ id: SettingsTab; label: string; freq: string }> = [
  { id: "meeting", label: "會議", freq: "每場" },
  { id: "account", label: "帳號", freq: "一次" },
  { id: "advanced", label: "進階", freq: "很少" },
];

const DEFAULT_UI: Config["ui"] = { translation_theme: "dark", glow: true };

const INPUT =
  "rounded-md border border-paper-300 bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ai-blue/40 disabled:opacity-50";
const SELECT = `w-full ${INPUT}`;
const CHECKBOX = "h-4 w-4 cursor-pointer accent-ai-violet disabled:opacity-50";
const BTN_SECONDARY =
  "rounded-md border border-paper-300 px-2.5 py-1 text-xs text-paper-700 hover:bg-paper-100 disabled:opacity-50";
const BTN_PRIMARY =
  "rounded-md bg-paper-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-paper-800 disabled:bg-paper-400";

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
  initialTab = "meeting",
  onRerunChecklist,
  onRerunOnboarding,
}: {
  onClose: () => void;
  backend: Backend;
  setBackend: (b: Backend) => void;
  useMic: boolean;
  setUseMic: (v: boolean) => void;
  running: boolean;
  initialTab?: SettingsTab;
  onRerunChecklist?: () => void;
  onRerunOnboarding?: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
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
  // Enabling 同步口譯模式 multiplies translate calls; the toggle only flips
  // after the user reads the cost notice and confirms. Disabling never asks.
  const [confirmInterp, setConfirmInterp] = useState(false);
  // Which translation-slot windows the user has manually closed. An enabled
  // slot with a closed window shows a one-line notice + 重新開啟 button.
  const [closedSlots, setClosedSlots] = useState<{ t1: boolean; t2: boolean }>({
    t1: false,
    t2: false,
  });
  const [reopening, setReopening] = useState<SlotLabel | null>(null);
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

  const detectClosedSlots = useCallback(async () => {
    const [t1, t2] = await Promise.all([isSlotWindowOpen("t1"), isSlotWindowOpen("t2")]);
    return { t1: !t1, t2: !t2 };
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
    detectClosedSlots().then((r) => {
      if (!cancelled) setClosedSlots(r);
    });
    return () => {
      cancelled = true;
    };
  }, [detectClosedSlots]);

  async function reopenSlot(label: SlotLabel) {
    setReopening(label);
    setError(null);
    try {
      await openSlotWindow(label);
      setClosedSlots(await detectClosedSlots());
    } catch (e) {
      setError(`重新開啟譯文視窗失敗: ${e}`);
    } finally {
      setReopening(null);
    }
  }

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

  function updateStt(patch: Partial<Config["stt"]>) {
    if (!cfg) return;
    setCfg({ ...cfg, stt: { ...(cfg.stt ?? { openai_delay: "minimal" }), ...patch } });
  }

  function updateInterpMode(mode: "sentence" | "incremental") {
    if (!cfg) return;
    setCfg({ ...cfg, interp: { ...(cfg.interp ?? { mode: "sentence" }), mode } });
  }

  function updateUi(patch: Partial<Config["ui"]>) {
    if (!cfg) return;
    setCfg({ ...cfg, ui: { ...(cfg.ui ?? DEFAULT_UI), ...patch } });
  }

  const interpOn = cfg?.interp?.mode === "incremental";
  const ui = cfg?.ui ?? DEFAULT_UI;
  const providerIsOpenai = cfg?.api.provider === "openai";
  const anthropicRequired = !providerIsOpenai;
  const openaiRequired = providerIsOpenai || backend === "openai";

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

  const lockedHint = "錄音中無法變更，請先停止";

  function renderClosedSlotNotice(label: SlotLabel) {
    return (
      <p className="mt-1.5 flex items-center gap-2 text-xs text-warn-700">
        <span>譯文視窗已關閉</span>
        <button
          type="button"
          className="rounded-md border border-warn-200 bg-warn-50 px-2 py-0.5 text-xs font-medium text-warn-900 hover:bg-white disabled:opacity-50"
          onClick={() => reopenSlot(label)}
          disabled={reopening !== null}
        >
          {reopening === label ? "開啟中…" : "重新開啟"}
        </button>
      </p>
    );
  }

  return (
    <div className="absolute inset-0 z-10 flex items-stretch justify-center bg-paper-900/30 p-4">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-paper-200 bg-white shadow-xl">
        <header className="flex flex-shrink-0 items-center justify-between border-b border-paper-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-paper-900">設定</h2>
          <button
            className="rounded-md px-2 py-0.5 text-paper-500 hover:bg-paper-100 hover:text-paper-900"
            onClick={onClose}
            aria-label="關閉"
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-[168px] flex-shrink-0 flex-col gap-0.5 border-r border-paper-200 bg-paper-50 p-2.5"
            role="tablist"
            aria-label="設定分頁"
          >
            {TABS.map((t) => {
              const selected = tab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={selected}
                  type="button"
                  className={`relative flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${
                    selected
                      ? "bg-white font-medium text-paper-900 shadow-sm"
                      : "text-paper-700 hover:bg-paper-100"
                  }`}
                  onClick={() => setTab(t.id)}
                >
                  {selected && (
                    <span
                      className="ai-bar absolute bottom-2 left-0 top-2 w-[3px] rounded-full"
                      aria-hidden="true"
                    />
                  )}
                  <span>{t.label}</span>
                  <span className="text-[11px] font-normal text-paper-500">{t.freq}</span>
                </button>
              );
            })}
          </nav>

          {!cfg ? (
            <p className="px-6 py-6 text-sm text-paper-600">載入中…</p>
          ) : (
            <div className="flex-1 overflow-y-auto px-6 py-4 text-sm">
              {/* ================= 會議 ================= */}
              {tab === "meeting" && (
                <div className="divide-y divide-paper-100">
                  <Field
                    label="來源語言"
                    hint={running ? lockedHint : "你在會議中說的語言；變更後於下次開始錄音生效"}
                  >
                    <select
                      className={SELECT}
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
                      <p className="mt-2 rounded-md border border-paper-200 bg-paper-50 px-2 py-1.5 text-xs text-paper-700">
                        {swapNote}
                      </p>
                    )}
                  </Field>

                  <Field label="譯文視窗一">
                    <select
                      className={SELECT}
                      value={cfg.language.target_slots[0]}
                      onChange={(e) => handleSlotChange(0, e.target.value)}
                      disabled={running}
                    >
                      {slotOptions(cfg.language.source, cfg.language.target_slots[1], "二")}
                    </select>
                    {cfg.language.target_slots[0] !== "" &&
                      closedSlots.t1 &&
                      renderClosedSlotNotice("t1")}
                  </Field>

                  <Field label="譯文視窗二" hint="設為「不使用」可只留一個譯文視窗">
                    <select
                      className={SELECT}
                      value={cfg.language.target_slots[1]}
                      onChange={(e) => handleSlotChange(1, e.target.value)}
                      disabled={running}
                    >
                      <option value="">不使用</option>
                      {slotOptions(cfg.language.source, cfg.language.target_slots[0], "一")}
                    </select>
                    {cfg.language.target_slots[1] !== "" &&
                      closedSlots.t2 &&
                      renderClosedSlotNotice("t2")}
                  </Field>

                  <Field
                    label="辨識引擎"
                    hint={
                      running
                        ? lockedHint
                        : "本機 mlx-whisper 免費、離線可用；雲端較快，需 OpenAI key（帳號分頁）"
                    }
                  >
                    <select
                      className={SELECT}
                      value={backend}
                      onChange={(e) => setBackend(e.target.value as Backend)}
                      disabled={running}
                    >
                      <option value="local">本機 mlx-whisper（免費，離線可用）</option>
                      <option value="openai">雲端 OpenAI live-transcribe（按用量計費）</option>
                    </select>
                    {backend === "openai" && (
                      <p className="mt-2 rounded-md border border-warn-200 bg-warn-50 px-2 py-1.5 text-xs text-warn-900">
                        音訊會傳送至 OpenAI。中文以繁中（zh-tw）提示，啟用中的術語表會作為辨識提示；可改善辨識但不保證逐字命中。
                      </p>
                    )}
                  </Field>

                  {backend === "openai" && (
                    <Field
                      label="辨識延遲（雲端）"
                      hint={
                        running
                          ? lockedHint
                          : "越低字越早上螢幕；越高辨識越準。實測 minimal 比 low 快約 1.4 秒且準確度相當"
                      }
                    >
                      <select
                        className={SELECT}
                        value={cfg.stt?.openai_delay ?? "minimal"}
                        onChange={(e) => updateStt({ openai_delay: e.target.value })}
                        disabled={running}
                      >
                        {OPENAI_DELAY_LEVELS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}

                  {useMic && (
                    <Field
                      label="麥克風裝置"
                      hint={running ? lockedHint : "拔插藍芽耳機或外接麥克風後可按 ↻ 重新整理"}
                    >
                      <div className="flex gap-2">
                        <select
                          className={`flex-1 ${INPUT}`}
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
                          className={BTN_SECONDARY}
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
                    label="同步口譯模式（實驗）"
                    hint={
                      running
                        ? lockedHint
                        : "不等整句說完就開始翻譯，譯文只追加不修改，較接近真人同步口譯；需雲端辨識引擎才有效果"
                    }
                  >
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-700">
                      <input
                        type="checkbox"
                        className={CHECKBOX}
                        checked={interpOn}
                        disabled={running}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setConfirmInterp(true);
                          } else {
                            setConfirmInterp(false);
                            updateInterpMode("sentence");
                          }
                        }}
                      />
                      啟用同步口譯模式
                    </label>
                    {confirmInterp && !interpOn && (
                      <div
                        role="alertdialog"
                        aria-label="費用提醒"
                        className="mt-3 space-y-2 rounded-md border border-warn-200 bg-warn-50 px-3 py-2.5 text-xs text-warn-900"
                      >
                        <p className="font-medium">開啟前請確認費用變化</p>
                        <ul className="list-disc space-y-1 pl-4">
                          <li>翻譯 API 呼叫次數約增加為 {INTERP_CALL_MULTIPLIER}（每個語意片段呼叫一次）</li>
                          <li>
                            翻譯費用估計增加約 <strong>{INTERP_COST_INCREASE}</strong>
                            （兩個譯文視窗：每小時約 US${INTERP_COST_PER_HOUR_BEFORE_USD} → US$
                            {INTERP_COST_PER_HOUR_AFTER_USD}）
                          </li>
                          <li>辨識與總結費用不變</li>
                        </ul>
                        <div className="flex gap-2 pt-1">
                          <button
                            type="button"
                            className="rounded-md bg-paper-900 px-3 py-1 text-xs font-medium text-white hover:bg-paper-800"
                            onClick={() => {
                              updateInterpMode("incremental");
                              setConfirmInterp(false);
                            }}
                          >
                            確認開啟
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-warn-200 bg-white px-3 py-1 text-xs text-warn-900 hover:bg-warn-50"
                            onClick={() => setConfirmInterp(false)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                    {interpOn && backend !== "openai" && (
                      <p className="mt-2 text-xs text-warn-700">
                        本機 mlx-whisper 只能在句尾出字，同步口譯模式下行為與一般模式相同；切到雲端辨識引擎才會提前開口
                      </p>
                    )}
                  </Field>
                </div>
              )}

              {/* ================= 帳號 ================= */}
              {tab === "account" && (
                <div className="divide-y divide-paper-100">
                  <Field
                    label="翻譯引擎（LLM）"
                    hint="翻譯與總結使用的服務；選 OpenAI 時與雲端辨識共用同一把 OpenAI key"
                  >
                    <select
                      className={SELECT}
                      value={providerIsOpenai ? "openai" : "anthropic"}
                      onChange={(e) => update({ provider: e.target.value })}
                    >
                      <option value="anthropic">Anthropic（Claude，預設）</option>
                      <option value="openai">OpenAI（GPT）</option>
                    </select>
                  </Field>

                  <Field
                    label={
                      <>
                        Anthropic API key
                        <ReqTag required={anthropicRequired} />
                      </>
                    }
                    hint={
                      anthropicRequired
                        ? "用途：翻譯、總結。從 console.anthropic.com 建立"
                        : "用途：翻譯、總結（目前翻譯引擎為 OpenAI，此把可留空）"
                    }
                  >
                    <div className="flex gap-2">
                      <input
                        type={showAnthropic ? "text" : "password"}
                        className={`flex-1 font-mono text-xs ${INPUT}`}
                        value={cfg.api.anthropic_api_key}
                        onChange={(e) => update({ anthropic_api_key: e.target.value })}
                        placeholder="sk-ant-api03-..."
                      />
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={() => setShowAnthropic(!showAnthropic)}
                      >
                        {showAnthropic ? "隱藏" : "顯示"}
                      </button>
                    </div>
                  </Field>

                  <Field
                    label={
                      <>
                        OpenAI API key
                        <ReqTag required={openaiRequired} />
                      </>
                    }
                    hint={
                      providerIsOpenai
                        ? "用途：翻譯、總結、雲端辨識。platform.openai.com/api-keys"
                        : backend === "openai"
                          ? "用途：雲端辨識（目前辨識引擎為雲端）。platform.openai.com/api-keys"
                          : "用途：雲端辨識；只用本機辨識可留空"
                    }
                  >
                    <div className="flex gap-2">
                      <input
                        type={showOpenai ? "text" : "password"}
                        className={`flex-1 font-mono text-xs ${INPUT}`}
                        value={cfg.api.openai_api_key}
                        onChange={(e) => update({ openai_api_key: e.target.value })}
                        placeholder={openaiRequired ? "sk-..." : "（可留空）"}
                      />
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={() => setShowOpenai(!showOpenai)}
                      >
                        {showOpenai ? "隱藏" : "顯示"}
                      </button>
                    </div>
                  </Field>

                  <Field label="翻譯模型" hint="費用為概估：兩個譯文視窗、每小時約 30 分鐘語音">
                    <select
                      className={SELECT}
                      value={providerIsOpenai ? cfg.api.openai_model : cfg.api.model}
                      onChange={(e) =>
                        update(
                          providerIsOpenai
                            ? { openai_model: e.target.value }
                            : { model: e.target.value },
                        )
                      }
                    >
                      {(providerIsOpenai ? OPENAI_MODELS : MODELS).map((m) => (
                        <option key={m} value={m}>
                          {translateModelLabel(m)}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field
                    label="總結模型"
                    hint={
                      providerIsOpenai
                        ? "會議紀錄的 AI 總結使用；預設 gpt-5.6-sol，費用為一小時會議的單次概估"
                        : "會議紀錄的 AI 總結使用；預設 Sonnet 4.6，費用為一小時會議的單次概估"
                    }
                  >
                    <select
                      className={SELECT}
                      value={providerIsOpenai ? cfg.api.openai_summary_model : cfg.api.summary_model}
                      onChange={(e) =>
                        update(
                          providerIsOpenai
                            ? { openai_summary_model: e.target.value }
                            : { summary_model: e.target.value },
                        )
                      }
                    >
                      {(providerIsOpenai ? OPENAI_SUMMARY_MODELS : SUMMARY_MODELS).map((m) => (
                        <option key={m} value={m}>
                          {summaryModelLabel(m)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              {/* ================= 進階 ================= */}
              {tab === "advanced" && (
                <div className="divide-y divide-paper-100">
                  <Field
                    label="譯文視窗外觀"
                    hint="兩個譯文視窗共用，投影機色偏嚴重或不喜歡動態可關掉光暈"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <select
                        className={INPUT}
                        value={ui.translation_theme === "light" ? "light" : "dark"}
                        onChange={(e) => updateUi({ translation_theme: e.target.value })}
                      >
                        <option value="dark">純黑（投影預設）</option>
                        <option value="light">淺色</option>
                      </select>
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-700">
                        <input
                          type="checkbox"
                          className={CHECKBOX}
                          checked={ui.glow}
                          onChange={(e) => updateUi({ glow: e.target.checked })}
                        />
                        顯示 AI 光暈
                      </label>
                    </div>
                  </Field>

                  <Field
                    label="音源"
                    hint={running ? lockedHint : "預設使用麥克風；取消勾選則跑內建 weather demo 音檔"}
                  >
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-700">
                      <input
                        type="checkbox"
                        className={CHECKBOX}
                        checked={useMic}
                        onChange={(e) => setUseMic(e.target.checked)}
                        disabled={running}
                      />
                      使用麥克風
                    </label>
                  </Field>

                  <Field
                    label="閒置自動停止（分鐘）"
                    hint="超過設定分鐘無人說話則自動停止，避免雲端方案空轉計費；0 = 停用"
                  >
                    <input
                      type="number"
                      min={0}
                      max={120}
                      step={1}
                      className={`w-24 ${INPUT}`}
                      value={cfg.idle_auto_stop_minutes}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        updateIdleMinutes(Number.isFinite(v) && v >= 0 ? v : 0);
                      }}
                    />
                  </Field>

                  <Field label="會後自動總結" hint="錄音結束後自動用 AI 產生總結，完成後於歷史紀錄查看">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-700">
                      <input
                        type="checkbox"
                        className={CHECKBOX}
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
                            className={SELECT}
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
                                    className={CHECKBOX}
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

                  {(onRerunChecklist || onRerunOnboarding) && (
                    <Field label="系統狀態" hint="啟動檢查表會重新啟動辨識引擎並逐項驗證；首次設定會重跑 onboarding 流程">
                      <div className="flex flex-wrap gap-2">
                        {onRerunChecklist && (
                          <button
                            type="button"
                            className={BTN_SECONDARY}
                            onClick={onRerunChecklist}
                            disabled={running}
                          >
                            重新執行啟動檢查表
                          </button>
                        )}
                        {onRerunOnboarding && (
                          <button
                            type="button"
                            className={BTN_SECONDARY}
                            onClick={onRerunOnboarding}
                            disabled={running}
                          >
                            重新執行首次設定
                          </button>
                        )}
                      </div>
                    </Field>
                  )}

                  <Field label="檔案">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={() =>
                          invoke("open_config_folder").catch((e) => setError(`open: ${e}`))
                        }
                      >
                        設定資料夾
                      </button>
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={() =>
                          invoke("open_errors_log").catch((e) => setError(`open: ${e}`))
                        }
                      >
                        錯誤紀錄
                      </button>
                    </div>
                  </Field>
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <p className="mx-5 mb-2 rounded-md bg-danger-50 px-3 py-2 text-xs text-danger-700">
            {error}
          </p>
        )}

        <footer className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-paper-200 px-5 py-3">
          <span className="text-[11px] tabular-nums text-paper-500">
            {version ? `MeetingCast v${version}` : ""}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-sm text-paper-600 hover:bg-paper-100"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
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

function ReqTag({ required }: { required: boolean }) {
  return (
    <span
      className={`ml-2 rounded-full px-1.5 py-px text-[10px] font-normal ${
        required
          ? "border border-warn-200 bg-warn-50 text-warn-900"
          : "bg-paper-100 text-paper-700"
      }`}
    >
      {required ? "必要" : "選用"}
    </span>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-3.5 first:pt-0 last:pb-0">
      <label className="mb-1.5 flex items-center text-xs font-medium text-paper-700">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-paper-500">{hint}</p>}
    </div>
  );
}
