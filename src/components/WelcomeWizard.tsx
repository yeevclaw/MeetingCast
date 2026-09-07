import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import PrewarmChecklist, {
  type ModelProgress,
  type StepId,
  type StepStatus,
} from "@/components/PrewarmChecklist";
import { LANGS, nativeName, selectLabel, zhName } from "@/lib/languages";
import { openSlotWindow } from "@/lib/windows";
import type { Config } from "@/lib/types";

// 0 歡迎 → 1 選擇方式 → 2 麥克風 → 3 金鑰 → 4 語音模型 → 5 語言與視窗 → 6 試講一句
type StepIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const LAST_STEP: StepIndex = 6;

const STEP_LABELS: Record<StepIndex, string> = {
  0: "歡迎",
  1: "選擇方式",
  2: "麥克風",
  3: "金鑰",
  4: "語音模型",
  5: "語言與視窗",
  6: "試講一句",
};

// Static per-step time budget (minutes). The model step is replaced by the
// live download ETA when one is available.
const STEP_MINUTES: Record<StepIndex, number> = {
  0: 0,
  1: 0.5,
  2: 0.5,
  3: 2,
  4: 5,
  5: 0.5,
  6: 0.5,
};

type Backend = "local" | "openai";

/** Tri-state result from the Rust validate_*_key commands. */
type KeyCheck = "valid" | "invalid" | "unknown";

function KeyCheckHint({ check }: { check: KeyCheck | null }) {
  if (check === "valid") {
    return <p className="mt-1 text-xs text-ok-700">✓ 金鑰有效</p>;
  }
  if (check === "invalid") {
    return <p className="mt-1 text-xs text-danger-700">金鑰無效，請確認是否複製完整</p>;
  }
  if (check === "unknown") {
    return (
      <p className="mt-1 text-xs text-warn-700">暫時無法驗證（網路問題），先繼續也可以</p>
    );
  }
  return null;
}

function formatMinutes(min: number): string {
  if (min <= 0) return "不到 1 分";
  if (min < 1) return "不到 1 分";
  return `${Math.ceil(min)} 分`;
}

export default function WelcomeWizard({
  initialConfig,
  onDone,
  stepStatus,
  stepError,
  modelProgress,
  modelCached,
  retryPrewarm,
  micAvailable,
  probeMic,
  backend,
  setBackend,
  running,
  startTest,
  stopTest,
  latestSrc,
  lastFinal,
  latestTranslations,
  lagSec,
  online,
}: {
  initialConfig: Config;
  onDone: () => void;
  stepStatus: Record<StepId, StepStatus>;
  stepError: Partial<Record<StepId, string>>;
  modelProgress?: ModelProgress | null;
  modelCached?: boolean;
  retryPrewarm: () => void;
  micAvailable: boolean | null;
  probeMic: () => void;
  backend: Backend;
  setBackend: (b: Backend) => void;
  running: boolean;
  startTest: () => Promise<void>;
  stopTest: () => Promise<void>;
  latestSrc: string;
  lastFinal: string;
  latestTranslations: Record<string, string>;
  lagSec: number | null;
  online: boolean;
}) {
  const [step, setStep] = useState<StepIndex>(0);
  const [provider, setProvider] = useState<"anthropic" | "openai">(
    initialConfig.api.provider === "anthropic" ? "anthropic" : "openai",
  );
  // Both keys keep their own state so toggling the provider never loses an
  // already-typed value; every save writes both back.
  const [anthropic, setAnthropic] = useState(initialConfig.api.anthropic_api_key);
  const [openai, setOpenai] = useState(initialConfig.api.openai_api_key);
  const [showKey, setShowKey] = useState(false);
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [keyCheck, setKeyCheck] = useState<KeyCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(initialConfig.language?.source ?? "zh");
  const [slots, setSlots] = useState<[string, string]>([
    initialConfig.language?.target_slots?.[0] ?? "en",
    initialConfig.language?.target_slots?.[1] ?? "vi",
  ]);
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const [openingWindows, setOpeningWindows] = useState(false);
  const [testStarting, setTestStarting] = useState(false);
  // Set once the user has pressed 開始試講 at least once, so the checklist
  // doesn't show "waiting" rows before the test even began.
  const [testBegun, setTestBegun] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const hasPrewarmError = Object.values(stepStatus).some((s) => s === "error");
  const modelDone = stepStatus.model === "done";
  const hasInvalidKey = keyCheck === "invalid";
  const activeKey = provider === "openai" ? openai : anthropic;
  // Cloud STT is billed to OpenAI regardless of the LLM provider.
  const needsSeparateOpenaiKey = backend === "openai" && provider === "anthropic";

  const targets = useMemo(
    () => slots.filter((s, i) => s && s !== source && slots.indexOf(s) === i),
    [slots, source],
  );

  // Scroll the body back to the top on every step change.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [step]);

  // ---- ETA ----
  const remainingMinutes = useMemo(() => {
    let total = 0;
    for (let i = step; i <= LAST_STEP; i++) {
      const idx = i as StepIndex;
      if (idx === 4) {
        if (modelDone) continue;
        if (modelProgress?.etaSec != null && Number.isFinite(modelProgress.etaSec)) {
          total += modelProgress.etaSec / 60;
        } else {
          total += STEP_MINUTES[4];
        }
      } else if (idx === 2 && micAvailable === true) {
        continue;
      } else {
        total += STEP_MINUTES[idx];
      }
    }
    return total;
  }, [step, modelDone, modelProgress, micAvailable]);

  // ---- Persistence ----
  function buildConfig(complete: boolean): Config {
    return {
      ...initialConfig,
      api: {
        ...initialConfig.api,
        provider,
        anthropic_api_key: anthropic.trim(),
        openai_api_key: openai.trim(),
      },
      language: { source, target_slots: [slots[0], slots[1]] },
      stt: { ...initialConfig.stt, backend },
      onboarding_complete: complete,
    };
  }

  async function persist(complete: boolean): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      await invoke("set_config", { config: buildConfig(complete) });
      return true;
    } catch (e) {
      setError(`儲存失敗: ${e}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function skipAll() {
    if (await persist(true)) onDone();
  }

  async function goToTest() {
    // Everything the pipeline needs must be on disk before the first
    // start_stt: keys, languages, and the flag so a crash mid-test doesn't
    // re-show the wizard.
    if (await persist(true)) setStep(6);
  }

  async function finish() {
    if (running) {
      try {
        await stopTest();
      } catch {
        // stop failures shouldn't trap the user in the wizard
      }
    }
    onDone();
  }

  // ---- Keys ----
  async function handleKeysNext() {
    setValidating(true);
    try {
      const command = provider === "openai" ? "validate_openai_key" : "validate_anthropic_key";
      const a = await invoke<KeyCheck>(command, { key: activeKey.trim() });
      setKeyCheck(a);
      // Only a confirmed-invalid key blocks; "unknown" (network trouble)
      // never does.
      if (a !== "invalid") setStep(4);
    } catch {
      setStep(4);
    } finally {
      setValidating(false);
    }
  }

  // ---- Languages ----
  function handleSourceChange(newSource: string) {
    if (newSource === source) return;
    const next: [string, string] = [slots[0], slots[1]];
    let note: string | null = null;
    for (let i = 0; i < 2; i++) {
      if (next[i] === newSource) {
        next[i] = source;
        note = `已自動將譯文視窗${i === 0 ? "一" : "二"}改為${zhName(source)}（原設定與來源語言相同）`;
      }
    }
    setSwapNote(note);
    setSource(newSource);
    setSlots(next);
  }

  function handleSlotChange(idx: 0 | 1, value: string) {
    setSwapNote(null);
    const next: [string, string] = [slots[0], slots[1]];
    next[idx] = value;
    setSlots(next);
  }

  function slotOptions(otherSlot: string, otherName: "一" | "二") {
    return LANGS.map((l) => {
      const sameAsSource = l.code === source;
      const usedByOther = otherSlot !== "" && l.code === otherSlot;
      return (
        <option
          key={l.code}
          value={l.code}
          disabled={sameAsSource || usedByOther}
          title={
            sameAsSource ? "與來源語言相同" : usedByOther ? `已用於譯文視窗${otherName}` : undefined
          }
        >
          {selectLabel(l.code)}
        </option>
      );
    });
  }

  async function openWindows() {
    setOpeningWindows(true);
    try {
      await openSlotWindow("t1");
      if (slots[1] !== "") await openSlotWindow("t2");
    } catch (e) {
      setError(`開啟譯文視窗失敗: ${e}`);
    } finally {
      setOpeningWindows(false);
    }
  }

  // ---- Test ----
  async function beginTest() {
    setTestStarting(true);
    setTestBegun(true);
    try {
      await startTest();
    } finally {
      setTestStarting(false);
    }
  }

  const micState: "checking" | "ok" | "denied" =
    micAvailable === null ? "checking" : micAvailable ? "ok" : "denied";

  const canNext = (() => {
    switch (step) {
      case 3:
        return activeKey.trim().length > 0 && !validating;
      default:
        return true;
    }
  })();

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-paper-900/50 p-4">
      <div className="flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* ---- progress rail ---- */}
        <div className="border-b border-paper-200 px-7 pb-4 pt-5">
          <div className="grid grid-cols-7 gap-1.5">
            {([0, 1, 2, 3, 4, 5, 6] as StepIndex[]).map((i) => {
              const state = i < step ? "done" : i === step ? "now" : "todo";
              return (
                <div key={i} className="flex flex-col gap-1.5">
                  <span
                    className={`h-1 rounded-full ${
                      state === "done" ? "bg-paper-900" : state === "now" ? "ai-bar" : "bg-paper-200"
                    }`}
                  />
                  <span
                    className={`truncate text-[11px] ${
                      state === "now" ? "font-medium text-paper-900" : "text-paper-500"
                    }`}
                  >
                    {i} {STEP_LABELS[i]}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-paper-600">
            已完成 {step} / 6 · 剩約 <span className="tabular-nums">{formatMinutes(remainingMinutes)}</span>
            {step <= 4 && !modelDone && stepStatus.model === "in_progress" && (
              <span className="text-paper-500">（模型下載在背景進行，不必等它）</span>
            )}
          </p>
        </div>

        {/* ---- body (fixed height so steps don't jump) ---- */}
        <div ref={bodyRef} className="h-[min(520px,calc(100vh-230px))] overflow-y-auto px-7 py-6">
          {step === 0 && (
            <StepShell
              title={
                <>
                  <span className="ai-text">MeetingCast</span>
                </>
              }
              subtitle="讓每一位聽眾，都聽得懂。"
            >
              <Block h="在做什麼">
                <p>
                  你在台上講，MeetingCast 即時把話變成逐字稿，同時翻成兩種你選的語言，各自顯示在一個可以拖到投影機的視窗。
                </p>
              </Block>
              <Block h="接下來">
                <ul className="list-disc space-y-1 pl-4">
                  <li>App 會開三個視窗：主控台＋兩個譯文視窗（可拖到外接螢幕）</li>
                  <li>macOS 會跳出麥克風授權，請按「允許」</li>
                  <li>首次啟動會在背景下載語音模型（約 1.5 GB），下載期間可以先完成其他設定</li>
                </ul>
              </Block>
              <Block h="多久">
                <p>
                  全部約 <span className="tabular-nums">{formatMinutes(remainingMinutes)}</span>
                  ，其中大部分是等模型下載。每一步都可以略過，之後在主控台或「設定」補。
                </p>
              </Block>
            </StepShell>
          )}

          {step === 1 && (
            <StepShell title="1 · 選擇辨識方式" subtitle="決定聲音在哪裡變成文字。之後可在主控台右欄切換。">
              <Block h="在做什麼">
                <div className="grid grid-cols-2 gap-3">
                  <ChoiceCard
                    selected={backend === "local"}
                    onClick={() => setBackend("local")}
                    title="本機辨識"
                    tag="預設"
                    lines={[
                      "免費，聲音不離開這台電腦",
                      "沒網路也能出逐字稿",
                      "首次需下載 1.5 GB 模型",
                      "延遲約 1–2 秒，建議 Apple Silicon",
                    ]}
                  />
                  <ChoiceCard
                    selected={backend === "openai"}
                    onClick={() => setBackend("openai")}
                    title="雲端辨識"
                    tag="較快"
                    lines={[
                      "OpenAI gpt-live-transcribe",
                      "比本機約快 1 秒，邊講邊出字",
                      "需要網路與 OpenAI API key",
                      "約 US$1 / 小時",
                    ]}
                  />
                </div>
              </Block>
              <Block h="多久">
                <p>不到 1 分。</p>
              </Block>
              <Block h="可能問題">
                <ul className="list-disc space-y-1 pl-4">
                  <li>場地可能沒網路 → 選本機；就算選雲端，本機模型也會備著，現場可切回</li>
                  <li>電腦不是 Apple Silicon → 本機辨識會明顯變慢，建議雲端</li>
                </ul>
              </Block>
            </StepShell>
          )}

          {step === 2 && (
            <StepShell title="2 · 麥克風授權" subtitle="沒有聲音進來，後面什麼都不會動。">
              <Block h="在做什麼">
                <div className="flex items-center gap-3 rounded-xl border border-paper-200 bg-paper-50 px-4 py-3">
                  {micState === "checking" && (
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-paper-200 border-t-ai-violet" />
                  )}
                  {micState === "ok" && (
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-ok-700 text-[11px] font-bold text-white">
                      ✓
                    </span>
                  )}
                  {micState === "denied" && (
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-warn-700 text-[11px] font-bold text-white">
                      !
                    </span>
                  )}
                  <div className="flex-1 text-sm">
                    {micState === "checking" && <p className="text-paper-700">正在檢查麥克風…請在系統對話框按「允許」</p>}
                    {micState === "ok" && <p className="font-medium text-paper-900">麥克風可用</p>}
                    {micState === "denied" && (
                      <>
                        <p className="font-medium text-warn-900">尚未授權或找不到麥克風</p>
                        <p className="text-xs text-warn-700">
                          系統設定 → 隱私權與安全性 → 麥克風 → 允許 MeetingCast
                        </p>
                      </>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-paper-300 bg-white px-3 py-1.5 text-xs text-paper-800 hover:bg-paper-100"
                      onClick={() => invoke("open_mic_settings").catch(() => {})}
                    >
                      打開系統設定
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-paper-300 bg-white px-3 py-1.5 text-xs text-paper-800 hover:bg-paper-100"
                      onClick={probeMic}
                    >
                      重新檢查
                    </button>
                  </div>
                </div>
              </Block>
              <Block h="多久">
                <p>約 10 秒。</p>
              </Block>
              <Block h="可能問題">
                <ul className="list-disc space-y-1 pl-4">
                  <li>按到「不允許」 → 打開系統設定手動勾選 MeetingCast，回來按「重新檢查」</li>
                  <li>要用藍牙耳機或外接麥克風 → 先接好，之後在主控台右欄「本場設定 → 麥克風」選它</li>
                  <li>授權後仍顯示未授權 → 重新啟動 App（macOS 限制，只需一次）</li>
                </ul>
              </Block>
            </StepShell>
          )}

          {step === 3 && (
            <StepShell title="3 · API 金鑰" subtitle="翻譯要用大語言模型，金鑰只存在這台電腦的設定檔。">
              <Block h="在做什麼">
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-paper-700">翻譯引擎</label>
                    <div className="flex gap-2">
                      {(
                        [
                          { id: "openai", label: "OpenAI（GPT）" },
                          { id: "anthropic", label: "Anthropic（Claude）" },
                        ] as const
                      ).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={
                            provider === p.id
                              ? "flex-1 rounded-lg border border-paper-900 bg-paper-900 px-3 py-1.5 text-xs font-medium text-white"
                              : "flex-1 rounded-lg border border-paper-300 px-3 py-1.5 text-xs text-paper-700 hover:bg-paper-100"
                          }
                          onClick={() => {
                            setProvider(p.id);
                            setKeyCheck(null);
                          }}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-paper-500">
                      {provider === "openai"
                        ? "預設；翻譯、總結與雲端辨識共用同一把 OpenAI key"
                        : "翻譯與總結呼叫 Claude；若選雲端辨識仍需另一把 OpenAI key"}
                    </p>
                  </div>

                  <KeyField
                    label={`${provider === "openai" ? "OpenAI" : "Anthropic"} API key`}
                    required
                    href={
                      provider === "openai"
                        ? "https://platform.openai.com/api-keys"
                        : "https://console.anthropic.com/settings/keys"
                    }
                    value={activeKey}
                    onChange={(v) => {
                      if (provider === "openai") setOpenai(v);
                      else setAnthropic(v);
                      setKeyCheck(null);
                    }}
                    placeholder={provider === "openai" ? "sk-..." : "sk-ant-api03-..."}
                    show={showKey}
                    onToggleShow={() => setShowKey(!showKey)}
                    hint={provider === "openai" ? "用途：翻譯、總結、雲端辨識" : "用途：翻譯、總結"}
                    autoFocus
                  >
                    <KeyCheckHint check={keyCheck} />
                  </KeyField>

                  {needsSeparateOpenaiKey && (
                    <KeyField
                      label="OpenAI API key"
                      required
                      href="https://platform.openai.com/api-keys"
                      value={openai}
                      onChange={setOpenai}
                      placeholder="sk-..."
                      show={showOpenaiKey}
                      onToggleShow={() => setShowOpenaiKey(!showOpenaiKey)}
                      hint="用途：你在第 1 步選了雲端辨識，辨識由 OpenAI 計費"
                    />
                  )}
                </div>
              </Block>
              <Block h="多久">
                <p>約 2 分（含到網站建立金鑰）。</p>
              </Block>
              <Block h="可能問題">
                <ul className="list-disc space-y-1 pl-4">
                  <li>顯示金鑰無效 → 通常是少複製了頭尾幾個字元，重貼一次</li>
                  <li>沒網路無法驗證 → 可以先繼續，第一次開始錄音時會再檢查</li>
                  <li>還沒有金鑰 → 按「略過」，之後在「設定 → 帳號」填</li>
                </ul>
              </Block>
            </StepShell>
          )}

          {step === 4 && (
            <StepShell title="4 · 語音模型" subtitle="下方步驟自動完成，不必盯著。">
              {backend === "openai" && (
                <p className="rounded-lg border border-paper-200 bg-paper-50 px-3 py-2 text-xs text-paper-700">
                  你選了雲端辨識，不需要等模型下載；本機模型仍會在背景準備，以備現場沒網路時切換。
                </p>
              )}
              <Block h="在做什麼">
                <p className="mb-3">
                  下載 Whisper large-v3-turbo（約 1.5 GB），之後離線也能辨識。只需一次，下次啟動直接讀快取。
                </p>
                <div className="rounded-xl border border-paper-200 bg-paper-50 px-4 py-3">
                  <PrewarmChecklist
                    stepStatus={stepStatus}
                    stepError={stepError}
                    modelProgress={modelProgress}
                    modelCached={modelCached}
                  />
                  {hasPrewarmError && (
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        className="rounded-lg border border-paper-300 bg-white px-3 py-1.5 text-xs text-paper-800 hover:bg-paper-100"
                        onClick={retryPrewarm}
                      >
                        重試
                      </button>
                      <p className="text-[11px] text-paper-500">會從中斷處續傳，不會重頭下載</p>
                    </div>
                  )}
                </div>
              </Block>
              <Block h="多久">
                <p>
                  {modelDone
                    ? "模型已就緒。"
                    : modelProgress?.etaSec != null && Number.isFinite(modelProgress.etaSec)
                      ? `剩約 ${formatMinutes(modelProgress.etaSec / 60)}，依網速而定。`
                      : "一般網路約 3–8 分，依網速而定。"}
                </p>
              </Block>
              <Block h="可能問題">
                <ul className="list-disc space-y-1 pl-4">
                  <li>磁碟剩不到 2 GB → 清出空間後按「重試」</li>
                  <li>公司網路擋 huggingface.co → 改用手機熱點，或回第 1 步先選雲端辨識</li>
                  <li>下載中斷或停滯 → 會從中斷處續傳，按「重試」即可</li>
                </ul>
              </Block>
            </StepShell>
          )}

          {step === 5 && (
            <StepShell title="5 · 語言與視窗" subtitle="你講什麼語言，要翻成哪兩種。">
              <Block h="在做什麼">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-paper-700">來源語言</label>
                    <select
                      className="w-full rounded-lg border border-paper-300 bg-white px-2 py-1.5 text-sm"
                      value={source}
                      onChange={(e) => handleSourceChange(e.target.value)}
                    >
                      {LANGS.filter((l) => l.source_capable).map((l) => (
                        <option key={l.code} value={l.code}>
                          {selectLabel(l.code)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-paper-700">譯文視窗一</label>
                    <select
                      className="w-full rounded-lg border border-paper-300 bg-white px-2 py-1.5 text-sm"
                      value={slots[0]}
                      onChange={(e) => handleSlotChange(0, e.target.value)}
                    >
                      {slotOptions(slots[1], "二")}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-paper-700">譯文視窗二</label>
                    <select
                      className="w-full rounded-lg border border-paper-300 bg-white px-2 py-1.5 text-sm"
                      value={slots[1]}
                      onChange={(e) => handleSlotChange(1, e.target.value)}
                    >
                      <option value="">不使用</option>
                      {slotOptions(slots[0], "一")}
                    </select>
                  </div>
                </div>
                {swapNote && (
                  <p className="mt-2 rounded-lg border border-paper-200 bg-paper-50 px-2 py-1.5 text-xs text-paper-700">
                    {swapNote}
                  </p>
                )}
                <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-paper-200 bg-paper-50 px-4 py-3">
                  <p className="text-xs text-paper-700">
                    兩個譯文視窗各自獨立，可以分別拖到不同的投影機或電視；關掉了也能從主控台再開。
                  </p>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-paper-300 bg-white px-3 py-1.5 text-xs text-paper-800 hover:bg-paper-100 disabled:opacity-50"
                    onClick={openWindows}
                    disabled={openingWindows}
                  >
                    {openingWindows ? "開啟中…" : "開啟譯文視窗 ↗"}
                  </button>
                </div>
              </Block>
              <Block h="多久">
                <p>不到 1 分。</p>
              </Block>
              <Block h="可能問題">
                <ul className="list-disc space-y-1 pl-4">
                  <li>只有一台投影機 → 譯文視窗二設「不使用」，或兩窗上下排在同一螢幕</li>
                  <li>想翻成柬埔寨文 → 可以，但它只能當譯文，不能當來源</li>
                  <li>之後要換語言 → 主控台右側「本場設定」隨時可改</li>
                </ul>
              </Block>
            </StepShell>
          )}

          {step === 6 && (
            <StepShell title="6 · 試講一句" subtitle="對著麥克風講一句，看三件事都動起來。">
              {!online && backend === "openai" && (
                <p className="rounded-lg border border-warn-200 bg-warn-50 px-3 py-2 text-xs text-warn-900">
                  目前偵測不到網路，雲端辨識會失敗。可以先改本機辨識再試，或稍後再試。
                </p>
              )}
              <Block h="在做什麼">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    {!running ? (
                      <button
                        type="button"
                        className="ai-fill rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
                        onClick={beginTest}
                        disabled={testStarting}
                      >
                        {testStarting ? "啟動中…" : testBegun ? "再試一次" : "開始試講"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rounded-xl bg-recording px-5 py-2.5 text-sm font-semibold text-white"
                        onClick={() => stopTest()}
                      >
                        結束試講
                      </button>
                    )}
                    <p className="text-xs text-paper-500">
                      例如：「大家好，今天我們來討論第三季的業績表現。」
                    </p>
                  </div>
                  <div className="rounded-xl border border-paper-200 bg-paper-50 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-paper-500">
                      逐字稿 · {zhName(source)}
                      {lagSec != null && (
                        <span className="ml-2 normal-case tracking-normal tabular-nums">
                          落後 {lagSec.toFixed(1)} 秒
                        </span>
                      )}
                    </p>
                    <p className="mt-1 min-h-[1.6em] text-lg font-medium text-paper-900">
                      {lastFinal || (
                        <span className="text-sm font-normal text-paper-400">
                          {running ? "聆聽中…請開始說話" : "還沒有內容"}
                        </span>
                      )}
                    </p>
                    {latestSrc && <p className="ai-caret text-sm text-paper-500">{latestSrc}</p>}
                    {targets.length > 0 && (
                      <div className="mt-3 grid gap-2 border-t border-paper-200 pt-3">
                        {targets.map((t) => (
                          <div key={t} className="grid grid-cols-[72px_1fr] gap-2 text-sm">
                            <span className="text-xs text-paper-500">{nativeName(t)}</span>
                            <span className="text-paper-800">
                              {latestTranslations[t] || <span className="text-paper-400">…</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 text-sm">
                    <CheckRow ok={running || !!lastFinal} pending={testBegun && !running && !lastFinal} label="麥克風收到聲音" />
                    <CheckRow
                      ok={!!lastFinal}
                      pending={running && !lastFinal}
                      label={`辨識出字（${backend === "openai" ? "雲端" : "本機"}）`}
                      right={lagSec != null ? `${lagSec.toFixed(1)}s` : ""}
                    />
                    {targets.map((t) => (
                      <CheckRow
                        key={t}
                        ok={!!latestTranslations[t]}
                        pending={!!lastFinal && !latestTranslations[t]}
                        label={`${nativeName(t)} 譯文出現`}
                      />
                    ))}
                  </div>
                </div>
              </Block>
              <Block h="多久">
                <p>約 30 秒。</p>
              </Block>
              <Block h="沒出字時">
                <ul className="list-disc space-y-1 pl-4">
                  <li>先看主控台狀態列的「麥克風」：沒有音量條在動 → 回第 2 步，或換麥克風裝置</li>
                  <li>再看「辨識」：本機模型還在載入會顯示準備中，等它完成再講一次</li>
                  <li>最後看「翻譯」：金鑰無效或沒網路都會在這裡標示，點它有一鍵修正</li>
                </ul>
              </Block>
            </StepShell>
          )}
        </div>

        {/* ---- footer ---- */}
        {error && (
          <p className="mx-7 mb-2 rounded-lg bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</p>
        )}
        <footer className="flex items-center justify-between gap-3 border-t border-paper-200 px-7 py-4">
          <div>
            {step === 0 ? (
              <button
                type="button"
                className="text-xs text-paper-500 hover:text-paper-800 disabled:opacity-50"
                onClick={skipAll}
                disabled={saving}
              >
                略過，直接使用
              </button>
            ) : (
              <button
                type="button"
                className="rounded-lg px-3 py-2 text-sm text-paper-600 hover:bg-paper-100 disabled:opacity-50"
                onClick={() => setStep((s) => Math.max(0, s - 1) as StepIndex)}
                disabled={running}
              >
                ← 上一步
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {step === 3 && (
              <>
                <button
                  type="button"
                  className="text-xs text-paper-500 underline-offset-2 hover:text-paper-700 hover:underline"
                  onClick={() => setStep(4)}
                >
                  略過，稍後在設定填
                </button>
                {hasInvalidKey && (
                  <button
                    type="button"
                    className="text-xs text-danger-700 underline-offset-2 hover:underline"
                    onClick={() => setStep(4)}
                  >
                    仍要繼續
                  </button>
                )}
              </>
            )}
            {step === 4 && !modelDone && (
              <span className="text-xs text-paper-500">下載會繼續，並留在主控台狀態列</span>
            )}

            {step === 0 && (
              <button
                type="button"
                className="ai-fill rounded-xl px-5 py-2 text-sm font-semibold"
                onClick={() => setStep(1)}
              >
                開始設定
              </button>
            )}
            {(step === 1 || step === 2) && (
              <button
                type="button"
                className="rounded-xl bg-paper-900 px-5 py-2 text-sm font-medium text-white hover:bg-paper-800"
                onClick={() => setStep((s) => (s + 1) as StepIndex)}
              >
                {step === 2 && micState !== "ok" ? "先跳過，下一步 →" : "下一步 →"}
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                className="rounded-xl bg-paper-900 px-5 py-2 text-sm font-medium text-white hover:bg-paper-800 disabled:bg-paper-400"
                onClick={handleKeysNext}
                disabled={!canNext}
              >
                {validating ? "驗證中…" : "下一步 →"}
              </button>
            )}
            {step === 4 && (
              <button
                type="button"
                className="rounded-xl bg-paper-900 px-5 py-2 text-sm font-medium text-white hover:bg-paper-800"
                onClick={() => setStep(5)}
              >
                {modelDone ? "下一步 →" : "先做下一步 →"}
              </button>
            )}
            {step === 5 && (
              <button
                type="button"
                className="rounded-xl bg-paper-900 px-5 py-2 text-sm font-medium text-white hover:bg-paper-800 disabled:bg-paper-400"
                onClick={goToTest}
                disabled={saving}
              >
                {saving ? "儲存中…" : "下一步 →"}
              </button>
            )}
            {step === 6 && (
              <button
                type="button"
                className="ai-fill rounded-xl px-5 py-2 text-sm font-semibold"
                onClick={finish}
              >
                完成，開始使用
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------- building blocks ----------

function StepShell({
  title,
  subtitle,
  children,
}: {
  title: React.ReactNode;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-paper-900">{title}</h2>
        <p className="mt-1 text-sm text-paper-600">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function Block({ h, children }: { h: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] gap-3 text-sm text-paper-800">
      <span className="pt-0.5 text-[11px] uppercase tracking-widest text-paper-500">{h}</span>
      <div>{children}</div>
    </div>
  );
}

function ChoiceCard({
  selected,
  onClick,
  title,
  tag,
  lines,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  tag: string;
  lines: string[];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-xl border p-4 text-left transition ${
        selected
          ? "border-paper-900 bg-white shadow-sm ring-2 ring-paper-900/10"
          : "border-paper-200 bg-paper-50 hover:bg-white"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-paper-900">{title}</span>
        <span className="rounded-full bg-paper-100 px-2 py-0.5 text-[10px] text-paper-700">{tag}</span>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-paper-700">
        {lines.map((l) => (
          <li key={l}>· {l}</li>
        ))}
      </ul>
    </button>
  );
}

function KeyField({
  label,
  required,
  href,
  value,
  onChange,
  placeholder,
  show,
  onToggleShow,
  hint,
  autoFocus,
  children,
}: {
  label: string;
  required?: boolean;
  href: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  show: boolean;
  onToggleShow: () => void;
  hint: string;
  autoFocus?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 flex items-center justify-between text-xs font-medium text-paper-700">
        <span>
          {label}
          {required && <span className="ml-1 rounded-full bg-warn-50 px-1.5 py-0.5 text-[10px] text-warn-900">必要</span>}
        </span>
        <a className="text-xs text-ai-blue hover:underline" href={href} target="_blank" rel="noreferrer">
          取得金鑰 ↗
        </a>
      </label>
      <div className="flex gap-2">
        <input
          type={show ? "text" : "password"}
          className="flex-1 rounded-lg border border-paper-300 px-2 py-1.5 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          className="rounded-lg border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100"
          onClick={onToggleShow}
        >
          {show ? "隱藏" : "顯示"}
        </button>
      </div>
      <p className="mt-1 text-xs text-paper-500">{hint}</p>
      {children}
    </div>
  );
}

function CheckRow({
  ok,
  pending,
  label,
  right,
}: {
  ok: boolean;
  pending: boolean;
  label: string;
  right?: string;
}) {
  return (
    <>
      {ok ? (
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-ok-700 text-[10px] text-white">✓</span>
      ) : pending ? (
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-paper-200 border-t-ai-violet" />
      ) : (
        <span className="inline-block h-4 w-4 rounded-full border-2 border-paper-300" />
      )}
      <span className={ok ? "text-paper-900" : "text-paper-500"}>{label}</span>
      <span className="font-mono text-xs tabular-nums text-paper-500">{right ?? ""}</span>
    </>
  );
}
