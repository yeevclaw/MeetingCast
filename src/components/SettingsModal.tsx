import { useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { Config } from "@/lib/types";
import { LANGS, zhName } from "@/lib/languages";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { useEscapeKey } from "@/lib/useEscapeKey";
import {
  INTERP_CALL_MULTIPLIER,
  INTERP_COST_INCREASE,
  INTERP_COST_PER_HOUR_AFTER_USD,
  INTERP_COST_PER_HOUR_BEFORE_USD,
  OPENAI_DELAY_LEVELS,
  SUMMARY_COST_PER_RUN,
  TRANSLATE_COST_PER_HOUR,
} from "@/lib/cost";

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

/** Tri-state result from the Rust validate_*_key commands, plus in-flight. */
type KeyCheck = "valid" | "invalid" | "unknown" | "checking";

function KeyCheckHint({ check }: { check: KeyCheck | null }) {
  if (check === "checking") return <p role="status" className="mt-1 text-xs text-paper-600">驗證中…</p>;
  if (check === "valid") return <p role="status" className="mt-1 text-xs text-ok-700">✓ 有效</p>;
  if (check === "invalid")
    return <p role="status" className="mt-1 text-xs text-danger-700">無效：請確認是否複製完整</p>;
  if (check === "unknown")
    return <p role="status" className="mt-1 text-xs text-warn-700">無法確認（網路問題），仍可儲存</p>;
  return null;
}
// Per-meeting settings (languages, STT engine, mic) live on the console's
// 本場設定 card (SessionSetupCard); this modal only holds what rarely changes.
export type SettingsTab = "account" | "advanced";

const TABS: Array<{ id: SettingsTab; label: string; freq: string }> = [
  { id: "account", label: "帳號", freq: "一次" },
  { id: "advanced", label: "進階", freq: "很少" },
];

const DEFAULT_UI: Config["ui"] = { translation_theme: "dark", glow: true };

const INPUT =
  "rounded-md border border-paper-300 bg-white px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-paper-700 focus-visible:ring-offset-1 disabled:opacity-50";
const SELECT = `w-full ${INPUT}`;
const CHECKBOX = "h-4 w-4 cursor-pointer accent-ai-violet disabled:opacity-50";
const BTN_SECONDARY =
  "rounded-md border border-paper-300 px-2.5 py-1 text-xs text-paper-700 hover:bg-paper-100 disabled:opacity-50";
const BTN_PRIMARY =
  "rounded-md bg-paper-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-paper-800 disabled:bg-paper-400";

export default function SettingsModal({
  onClose,
  backend,
  useMic,
  setUseMic,
  running,
  initialTab = "account",
  onRerunChecklist,
  onRerunOnboarding,
}: {
  onClose: () => void;
  backend: Backend;
  useMic: boolean;
  setUseMic: (v: boolean) => void;
  running: boolean;
  initialTab?: SettingsTab;
  onRerunChecklist?: () => void;
  onRerunOnboarding?: () => void;
}) {
  const dialogRef = useFocusTrap();
  const titleId = useId();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showOpenai, setShowOpenai] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  // Enabling 同步口譯模式 multiplies translate calls; the toggle only flips
  // after the user reads the cost notice and confirms. Disabling never asks.
  const [confirmInterp, setConfirmInterp] = useState(false);
  // 使用麥克風 is a draft like every other field: applied on 儲存, dropped
  // on 取消 (it lives in console state, not config, so it's applied via
  // setUseMic rather than set_config).
  const [micDraft, setMicDraft] = useState(useMic);
  // Snapshot of the config as loaded, for the unsaved-changes check.
  const loadedJson = useRef<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const discardRef = useFocusTrap(confirmDiscard);
  const [openaiCheck, setOpenaiCheck] = useState<KeyCheck | null>(null);
  const [anthropicCheck, setAnthropicCheck] = useState<KeyCheck | null>(null);
  // Last key value each check ran against, so blur without edits doesn't re-bill a probe.
  const checkedKey = useRef<{ openai: string | null; anthropic: string | null }>({
    openai: null,
    anthropic: null,
  });
  useEffect(() => {
    invoke<Config>("get_config")
      .then((c) => {
        loadedJson.current = JSON.stringify(c);
        setCfg(c);
      })
      .catch((e) => setError(`load: ${e}`));
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const dirty =
    micDraft !== useMic ||
    (cfg != null && loadedJson.current != null && JSON.stringify(cfg) !== loadedJson.current);

  // ✕ / 取消 / Esc all go through here: unsaved edits ask before discarding.
  const requestClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [dirty, onClose]);
  useEscapeKey(
    true,
    useCallback(() => {
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
    }, [confirmDiscard, requestClose]),
  );

  async function validateKey(which: "openai" | "anthropic", value: string) {
    const key = value.trim();
    const set = which === "openai" ? setOpenaiCheck : setAnthropicCheck;
    if (!key) {
      checkedKey.current[which] = null;
      set(null);
      return;
    }
    if (checkedKey.current[which] === key) return;
    checkedKey.current[which] = key;
    set("checking");
    try {
      const r = await invoke<string>(
        which === "openai" ? "validate_openai_key" : "validate_anthropic_key",
        { key },
      );
      // Ignore a stale answer if the field changed while we waited.
      if (checkedKey.current[which] !== key) return;
      set(r === "valid" || r === "invalid" ? r : "unknown");
    } catch {
      if (checkedKey.current[which] === key) set("unknown");
    }
  }

  async function handleSave() {
    if (!cfg) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("set_config", { config: cfg });
      if (micDraft !== useMic) setUseMic(micDraft);
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
    setCfg({ ...cfg, stt: { ...(cfg.stt ?? { backend: "local", openai_delay: "minimal" }), ...patch } });
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

  const lockedHint = "錄音中無法變更，請先停止";

  return (
    <div className="absolute inset-0 z-10 flex items-stretch justify-center bg-paper-900/30 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-paper-200 bg-white shadow-xl">
        <header className="flex flex-shrink-0 items-center justify-between border-b border-paper-200 px-5 py-3">
          <h2 id={titleId} className="text-lg font-semibold text-paper-900">設定</h2>
          <button
            className="rounded-md px-2 py-0.5 text-paper-600 hover:bg-paper-100 hover:text-paper-900"
            onClick={requestClose}
            aria-label="關閉"
          >
            ✕︎
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
                  <span className="text-[11px] font-normal text-paper-600">{t.freq}</span>
                </button>
              );
            })}
          </nav>

          {!cfg ? (
            <p className="px-6 py-6 text-sm text-paper-600">載入中…</p>
          ) : (
            <div className="flex-1 overflow-y-auto px-6 py-4 text-sm">
              {/* ================= 帳號 ================= */}
              {tab === "account" && (
                <div className="divide-y divide-paper-100">
                  <Field
                    label="翻譯引擎（LLM）"
                    hint="翻譯與總結使用的服務；OpenAI 與雲端辨識共用同一把 key，Anthropic 則需另備 OpenAI key 才能用雲端辨識"
                  >
                    {(controlProps) => <>
                    <select {...controlProps}
                      className={SELECT}
                      value={providerIsOpenai ? "openai" : "anthropic"}
                      onChange={(e) => update({ provider: e.target.value })}
                    >
                      <option value="openai">OpenAI（GPT，預設）</option>
                      <option value="anthropic">Anthropic（Claude）</option>
                    </select>
                    </>}
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
                    {(controlProps) => <>
                    <div className="flex gap-2">
                      <input {...controlProps}
                        type={showOpenai ? "text" : "password"}
                        className={`flex-1 font-mono text-xs ${INPUT}`}
                        value={cfg.api.openai_api_key}
                        onChange={(e) => {
                          update({ openai_api_key: e.target.value });
                          checkedKey.current.openai = null;
                          setOpenaiCheck(null);
                        }}
                        onBlur={(e) => validateKey("openai", e.target.value)}
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
                    <KeyCheckHint check={openaiCheck} />
                    </>}
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
                    {(controlProps) => <>
                    <div className="flex gap-2">
                      <input {...controlProps}
                        type={showAnthropic ? "text" : "password"}
                        className={`flex-1 font-mono text-xs ${INPUT}`}
                        value={cfg.api.anthropic_api_key}
                        onChange={(e) => {
                          update({ anthropic_api_key: e.target.value });
                          checkedKey.current.anthropic = null;
                          setAnthropicCheck(null);
                        }}
                        onBlur={(e) => validateKey("anthropic", e.target.value)}
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
                    <KeyCheckHint check={anthropicCheck} />
                    </>}
                  </Field>

                  <Field label="翻譯模型" hint="費用為概估：兩個譯文視窗、每小時約 30 分鐘語音">
                    {(controlProps) => <>
                    <select {...controlProps}
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
                    </>}
                  </Field>

                  <Field
                    label="總結模型"
                    hint={
                      providerIsOpenai
                        ? "會議紀錄的 AI 總結使用；預設 gpt-5.6-sol，費用為一小時會議的單次概估"
                        : "會議紀錄的 AI 總結使用；預設 Sonnet 4.6，費用為一小時會議的單次概估"
                    }
                  >
                    {(controlProps) => <>
                    <select {...controlProps}
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
                    </>}
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
                    {(controlProps) => <>
                    <div className="flex flex-wrap items-center gap-3">
                      <select {...controlProps}
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
                    </>}
                  </Field>

                  <Field group
                    label="音源"
                    hint={running ? lockedHint : "預設使用麥克風；取消勾選則跑內建 weather demo 音檔（按「儲存」後生效）"}
                  >
                    {(controlProps) => <div role="group" {...controlProps}>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-700">
                      <input
                        type="checkbox"
                        className={CHECKBOX}
                        checked={micDraft}
                        onChange={(e) => setMicDraft(e.target.checked)}
                        disabled={running}
                      />
                      使用麥克風
                    </label>
                    </div>}
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
                    {(controlProps) => <>
                      <select {...controlProps}
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
                    </>}
                    </Field>
                  )}

                  <Field group
                    label="同步口譯模式（實驗）"
                    hint={
                      running
                        ? lockedHint
                        : "不等整句說完就開始翻譯，譯文只追加不修改，較接近真人同步口譯；需雲端辨識引擎才有效果"
                    }
                  >
                    {(controlProps) => <div role="group" {...controlProps}>
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
                    </div>}
                  </Field>

                  <Field
                    label="閒置自動停止（分鐘）"
                    hint="超過設定分鐘無人說話則自動停止，避免雲端方案空轉計費；0 = 停用"
                  >
                    {(controlProps) => (<input {...controlProps}
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
                    />)}
                  </Field>

                  <Field group label="會後自動總結" hint="錄音結束後自動用 AI 產生總結，完成後於歷史紀錄查看">
                    {(controlProps) => <div role="group" {...controlProps}>
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
                          <label htmlFor={`${controlProps.id}-template`} className="mb-1 block text-xs font-medium text-paper-700">
                            總結模板
                          </label>
                          <select id={`${controlProps.id}-template`}
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
                        <p className="text-xs text-paper-600">
                          每個語言各呼叫一次總結模型 API（與手動產生總結相同）
                        </p>
                      </div>
                    )}
                    </div>}
                  </Field>

                  {(onRerunChecklist || onRerunOnboarding) && (
                    <Field group label="系統狀態" hint="啟動檢查表會重新啟動辨識引擎並逐項驗證；首次設定會重跑 onboarding 流程">
                    {(controlProps) => <>
                      <div {...controlProps} role="group" className="flex flex-wrap gap-2">
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
                    </>}
                    </Field>
                  )}

                  <Field group label="檔案">
                    {(controlProps) => <>
                    <div {...controlProps} role="group" className="flex flex-wrap gap-2">
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
                    </>}
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
          <span className="text-[11px] tabular-nums text-paper-600">
            {version ? `MeetingCast v${version}` : ""}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-sm text-paper-600 hover:bg-paper-100"
              onClick={requestClose}
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

      {confirmDiscard && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper-900/30 p-4">
          <div
            ref={discardRef}
            tabIndex={-1}
            aria-modal="true"
            role="alertdialog"
            aria-label="放棄未儲存的變更"
            className="w-full max-w-sm rounded-2xl border border-paper-200 bg-white p-5 shadow-xl"
          >
            <h2 className="text-base font-semibold text-paper-900">放棄未儲存的變更？</h2>
            <p className="mt-2 text-sm text-paper-600">這次在設定裡改的內容還沒儲存，關閉後會還原。</p>
            <footer className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-sm text-paper-600 hover:bg-paper-100"
                onClick={() => setConfirmDiscard(false)}
                data-autofocus
              >
                繼續編輯
              </button>
              <button
                type="button"
                className="rounded-lg bg-danger-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-danger-900"
                onClick={() => {
                  setConfirmDiscard(false);
                  onClose();
                }}
              >
                放棄變更
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function ReqTag({ required }: { required: boolean }) {
  return (
    <span
      className={`ml-2 rounded-full px-1.5 py-px text-[11px] font-normal ${
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
  group = false,
  label,
  hint,
  children,
}: {
  group?: boolean;
  label: React.ReactNode;
  hint?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-labelledby"?: string }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="py-3.5 first:pt-0 last:pb-0">
      {group ? <span id={`${id}-label`} className="mb-1.5 flex items-center text-xs font-medium text-paper-700">{label}</span>
        : <label htmlFor={id} className="mb-1.5 flex items-center text-xs font-medium text-paper-700">{label}</label>}
      {children({ id, "aria-describedby": hint ? hintId : undefined, "aria-labelledby": group ? `${id}-label` : undefined })}
      {hint && <p id={hintId} className="mt-1 text-xs text-paper-600">{hint}</p>}
    </div>
  );
}
