import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import GlossaryModal from "@/components/GlossaryModal";
import HistoryModal from "@/components/HistoryModal";
import MicMeter from "@/components/MicMeter";
import PrewarmChecklist, {
  type ModelProgress,
  type StepId,
  type StepStatus,
} from "@/components/PrewarmChecklist";
import SettingsModal from "@/components/SettingsModal";
import WelcomeWizard from "@/components/WelcomeWizard";
import { estimateHourlyUsd, formatUsd } from "@/lib/cost";
import { friendly, isOfflineError } from "@/lib/errors";
import { LANGS, nativeName, zhName } from "@/lib/languages";
import type {
  ChunkPayload,
  Config,
  DonePayload,
  Source,
  TranscriptPayload,
} from "@/lib/types";
import { isSlotWindowOpen, openSlotWindow, type SlotLabel } from "@/lib/windows";

type Toast = { kind: "info" | "warning" | "error"; message: string };

type CrashPayload = { attempt: number; max: number; stderr_tail?: string };
type RestoredPayload = { attempt: number };
// `state` stays a plain string (not a union) so a future sidecar that emits
// an unknown state doesn't get miscast — unhandled states are ignored below.
// `downloaded_bytes` / `total_bytes` are only present on the model step's
// "progress" state; both optional keeps the payload wire-compatible.
type PrewarmPayload = {
  step: string;
  state: string;
  message?: string | null;
  downloaded_bytes?: number | null;
  total_bytes?: number | null;
  // Set on the model step's "progress" when weights were already cached (no
  // download) — the checklist shows a "已在本機" hint instead of a bar.
  cached?: boolean | null;
};

type SettingsTab = "meeting" | "account" | "advanced";
type ChipId = "rec" | "mic" | "stt" | "tr" | "net" | "lag";
type ChipTone = "neutral" | "ok" | "warn" | "bad";

function SettingsIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

function GlossaryIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h10M4 18h7" />
    </svg>
  );
}

function HistoryIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 10h8M8 14h5" />
    </svg>
  );
}

// The API key the selected LLM provider (translation + summary) actually
// uses — the wizard gate and the start pre-flight must check this one, not
// unconditionally the Anthropic key.
function activeLlmKey(cfg: Config): string {
  return cfg.api.provider === "openai" ? cfg.api.openai_api_key : cfg.api.anthropic_api_key;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ControlWindow() {
  const [running, setRunning] = useState(false);
  const [backend, setBackend] = useState<"local" | "openai">("local");
  const [useMic, setUseMic] = useState(true);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [micAvailable, setMicAvailable] = useState<boolean | null>(null);
  const [latestSrc, setLatestSrc] = useState<string>("");
  // Source language mirrored into state so the transcript panel's badge
  // re-renders on change; the ref below is the live copy handlers read.
  const [sourceLang, setSourceLang] = useState("zh");
  // Enabled target languages mirrored into state for the side column.
  const [targets, setTargets] = useState<string[]>([]);
  // Latest config snapshot for the 本場設定 card (cost estimate, engine…).
  const [cfgSnap, setCfgSnap] = useState<Config | null>(null);
  // One line per utterance. In incremental mode consecutive segments of the
  // same sentence group share an id and are merged into one line.
  const [history, setHistory] = useState<Array<{ id: string; text: string }>>([]);
  // Most recent translation per target language (for the side thumbnails and
  // the onboarding test step). Tracked from chunk events for every registry
  // language, independent of the sentence/incremental pending bookkeeping.
  const [latestTr, setLatestTr] = useState<Record<string, string>>({});
  const latestTrIdRef = useRef<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("meeting");
  const [showHistory, setShowHistory] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [pendingGlossaryTerm, setPendingGlossaryTerm] = useState<string | null>(null);
  const [transcriptMenu, setTranscriptMenu] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [showHistoryCoach, setShowHistoryCoach] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [needsWelcome, setNeedsWelcome] = useState<Config | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [sidecarReady, setSidecarReady] = useState<boolean | null>(null);
  const [stepStatus, setStepStatus] = useState<Record<StepId, StepStatus>>({
    spawn: "in_progress",
    model: "pending",
    mic: "pending",
  });
  const [stepError, setStepError] = useState<Partial<Record<StepId, string>>>({});
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null);
  // True while a cache-hit model load is in flight (weights already local, no
  // download). Mutually exclusive with modelProgress, which only gets set on a
  // real download.
  const [modelCached, setModelCached] = useState(false);
  const [retryingPrewarm, setRetryingPrewarm] = useState(false);
  // True while restart_sidecar is in flight. Prewarm/ready events arriving in
  // that window come from the OLD child winding down (its download poller
  // keeps emitting `progress` until the process dies) and must not touch the
  // freshly reset checklist — otherwise "spawn" flips to done with the other
  // rows stuck on pending.
  const restartingRef = useRef(false);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Network reachability of the LLM endpoint (Rust netcheck probe).
  const [online, setOnline] = useState(true);
  const onlineRef = useRef(true);
  // Seconds the newest final transcript trails wall-clock (audio t_end vs
  // time since recording started). null until the first final of a session.
  const [lagSec, setLagSec] = useState<number | null>(null);
  const [openChip, setOpenChip] = useState<ChipId | null>(null);
  // Which translation-slot windows currently exist.
  const [slotOpen, setSlotOpen] = useState<Record<SlotLabel, boolean>>({ t1: true, t2: true });
  const modelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Download-speed derivation for the model step. The sidecar only emits raw
  // byte counters every ~2s; speed (EMA-smoothed), ETA and stall detection
  // are computed here from consecutive samples.
  const dlSampleRef = useRef<{ bytes: number; t: number } | null>(null);
  const dlSpeedEmaRef = useRef<number | null>(null);
  const dlLastIncreaseRef = useRef<{ bytes: number; t: number } | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);
  const backendRef = useRef(backend);
  const useMicRef = useRef(useMic);
  const hasHistoryRef = useRef(false);
  const sessionStartedAtRef = useRef<number | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live language selection (source + two target slots). Kept in a ref so
  // event handlers read the current value without re-subscribing; the source
  // is mirrored into `sourceLang` state for the badge.
  const langCfgRef = useRef<{ source: string; slots: [string, string] }>({
    source: "zh",
    slots: ["en", "vi"],
  });
  // "sentence" | "incremental". In incremental mode Rust's interp engine owns
  // translation + persistence, so the transcript listener must not invoke
  // `translate` or seat pending utterances.
  const interpModeRef = useRef<string>("sentence");
  // Target languages we actually translate to: non-empty, not equal to the
  // source, deduped (slot order preserved).
  const enabledTargets = useCallback((): string[] => {
    const { source, slots } = langCfgRef.current;
    const out: string[] = [];
    for (const s of slots) {
      if (s && s !== source && !out.includes(s)) out.push(s);
    }
    return out;
  }, []);
  const applyLangCfg = useCallback(
    (cfg: Config) => {
      const source = cfg.language?.source ?? "zh";
      const slots = cfg.language?.target_slots ?? ["en", "vi"];
      langCfgRef.current = { source, slots: [slots[0] ?? "", slots[1] ?? ""] };
      interpModeRef.current = cfg.interp?.mode ?? "sentence";
      setSourceLang(source);
      setTargets(enabledTargets());
      setCfgSnap(cfg);
    },
    [enabledTargets],
  );
  // Which window label carries a target language, or null if neither slot does.
  const slotLabelFor = useCallback((lang: string): SlotLabel | null => {
    const { slots } = langCfgRef.current;
    if (slots[0] === lang) return "t1";
    if (slots[1] === lang) return "t2";
    return null;
  }, []);
  const restartClearNotice = (): string => {
    const src = zhName(langCfgRef.current.source);
    const ts = enabledTargets();
    return ts.length === 0
      ? `繼續會清除目前的${src}逐字稿與譯文。`
      : `繼續會清除目前的${src}逐字稿與${ts.map(zhName).join("／")}譯文。`;
  };

  const refreshSlotWindows = useCallback(async () => {
    const [t1, t2] = await Promise.all([isSlotWindowOpen("t1"), isSlotWindowOpen("t2")]);
    setSlotOpen({ t1, t2 });
  }, []);

  useEffect(() => {
    // First-run detection: show wizard until onboarding has been completed
    // (or skipped) once. Existing users who already have a key configured
    // never see it; a keyless skip isn't re-nagged on the next launch.
    invoke<Config>("get_config")
      .then((cfg) => {
        if (!cfg.onboarding_complete && !activeLlmKey(cfg).trim()) {
          setNeedsWelcome(cfg);
        }
        setSelectedDevice(cfg.audio?.input_device ?? "");
        applyLangCfg(cfg);
      })
      .catch(() => {
        // If config fetch fails, don't block the UI; user can still hit Settings.
      });
    // Sidecar may have already emitted `ready` before this listener mounts —
    // ask Rust for the current state so we don't show "preparing" forever.
    invoke<boolean>("sidecar_ready")
      .then((r) => {
        setSidecarReady(r);
        if (r) {
          // Backfill all step states so re-mounts (StrictMode, dev HMR, or
          // opening the window after the sidecar is already up) don't show
          // a stale "spawning" spinner.
          setStepStatus({ spawn: "done", model: "done", mic: "done" });
        }
      })
      .catch(() => setSidecarReady(true));
    invoke<boolean>("network_status")
      .then((o) => {
        onlineRef.current = o;
        setOnline(o);
      })
      .catch(() => {});
    refreshSlotWindows();
  }, [applyLangCfg, refreshSlotWindows]);

  // Re-check which translation windows exist whenever the console regains
  // focus (the user may have just closed one) — no polling.
  useEffect(() => {
    const onFocus = () => refreshSlotWindows();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshSlotWindows]);

  // Probe microphone permission / availability. getUserMedia triggers
  // macOS's privacy prompt for the .app bundle; once granted, the sidecar
  // subprocess inherits permission and opens its own InputStream without
  // re-prompting. We immediately stop the tracks because we only needed
  // the permission, not the audio data. Reused by the mount effect, the
  // mic chip's 重新檢查 button, and the window-focus re-check.
  const probeMic = useCallback(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      // Fallback: check device availability via enumerateDevices (no prompt).
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => setMicAvailable(d.some((dev) => dev.kind === "audioinput")))
        .catch(() => setMicAvailable(true));
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        setMicAvailable(true);
      })
      .catch(() => {
        // User denied or no mic device — the mic chip turns red with actions.
        setMicAvailable(false);
      });
  }, []);

  useEffect(() => {
    // Acquire microphone permission AT APP LAUNCH instead of on the user's
    // first 開始 click.
    probeMic();
  }, [probeMic]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    backendRef.current = backend;
  }, [backend]);
  useEffect(() => {
    useMicRef.current = useMic;
  }, [useMic]);
  useEffect(() => {
    hasHistoryRef.current = history.length > 0;
  }, [history]);
  useEffect(() => {
    sessionStartedAtRef.current = sessionStartedAt;
  }, [sessionStartedAt]);

  const showToast = useCallback((kind: Toast["kind"], message: string, ms = 4000) => {
    setToast({ kind, message });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (ms > 0) {
      toastTimerRef.current = setTimeout(() => setToast(null), ms);
    }
  }, []);

  function handleTranscriptContextMenu(e: React.MouseEvent) {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text) return; // no selection: let native menu fire (none in Tauri prod, but harmless)
    e.preventDefault();
    setTranscriptMenu({ x: e.clientX, y: e.clientY, text });
  }

  function addToGlossary(term: string) {
    setPendingGlossaryTerm(term);
    setShowGlossary(true);
    setTranscriptMenu(null);
  }

  // Click anywhere outside dismisses the floating context menu / chip
  // popover. Use mousedown so the menu closes before a re-click on transcript
  // text re-selects.
  useEffect(() => {
    if (!transcriptMenu && !openChip) return;
    const close = () => {
      setTranscriptMenu(null);
      setOpenChip(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [transcriptMenu, openChip]);

  // Track translation windows the user has closed so we (a) skip the
  // translate API call (no point paying tokens for a destination nobody can
  // see) and (b) toast exactly once per language so the user knows why
  // that language's translations stopped.
  const closedLangsNotifiedRef = useRef<Set<string>>(new Set());

  // Buffer for utterances waiting on their translations. Each entry is
  // appended to the session's transcript.jsonl exactly once — when every
  // enabled target finishes (or is skipped because the window is closed), or
  // when the user stops recording (in which case the row gets incomplete=true).
  // `translations` is keyed by the enabled targets snapshotted at seat time.
  type PendingUtterance = {
    src: string;
    t_start: number;
    t_end: number;
    translations: Record<string, { text: string; done: boolean; failed: boolean }>;
  };
  const pendingUtterancesRef = useRef<Map<string, PendingUtterance>>(new Map());
  const finalizedThisSessionRef = useRef(0);

  const tryFinalize = useCallback((id: string) => {
    const map = pendingUtterancesRef.current;
    const u = map.get(id);
    if (!u) return;
    const langs = Object.keys(u.translations);
    if (!langs.every((l) => u.translations[l].done)) return;
    map.delete(id);
    const translations: Record<string, string> = {};
    let anyFailed = false;
    for (const l of langs) {
      translations[l] = u.translations[l].text;
      if (u.translations[l].failed) anyFailed = true;
    }
    invoke("session_append_utterance", {
      utterance: {
        id,
        t_start: u.t_start,
        t_end: u.t_end,
        src: u.src,
        translations,
        incomplete: anyFailed,
      },
    })
      .then(() => {
        finalizedThisSessionRef.current += 1;
      })
      .catch((err) => console.error("session_append_utterance:", err));
  }, []);

  const flushPending = useCallback(async () => {
    const entries = Array.from(pendingUtterancesRef.current.entries());
    pendingUtterancesRef.current.clear();
    for (const [id, u] of entries) {
      const langs = Object.keys(u.translations);
      const translations: Record<string, string> = {};
      let incomplete = false;
      for (const l of langs) {
        translations[l] = u.translations[l].text;
        if (!u.translations[l].done || u.translations[l].failed) incomplete = true;
      }
      try {
        await invoke("session_append_utterance", {
          utterance: {
            id,
            t_start: u.t_start,
            t_end: u.t_end,
            src: u.src,
            translations,
            incomplete,
          },
        });
        finalizedThisSessionRef.current += 1;
      } catch (err) {
        console.error("flush session_append_utterance:", err);
      }
    }
  }, []);

  // Close one language's branch of a pending utterance without a translation
  // (window closed, offline, or a terminal API failure) so the finalizer
  // doesn't wait forever. The row is persisted as incomplete.
  const skipTranslation = useCallback(
    (id: string, target: string) => {
      const u = pendingUtterancesRef.current.get(id);
      const t = u?.translations[target];
      if (t) {
        t.failed = true;
        t.done = true;
        tryFinalize(id);
      }
    },
    [tryFinalize],
  );

  const requestTranslate = useCallback(
    async (id: string, text: string, target: string) => {
      const label = slotLabelFor(target);
      const win = label ? await WebviewWindow.getByLabel(label) : null;
      if (!win) {
        if (!closedLangsNotifiedRef.current.has(target)) {
          closedLangsNotifiedRef.current.add(target);
          showToast("warning", `${zhName(target)}譯文視窗已關閉，將不再翻譯該語言`);
        }
        skipTranslation(id, target);
        return;
      }
      // Offline: translation is paused, not broken. The 網路 chip and the
      // window banner already say so — don't bill a call that will fail.
      if (!onlineRef.current) {
        skipTranslation(id, target);
        return;
      }
      invoke("translate", { id, text, target }).catch((err) => {
        if (!isOfflineError(err)) setError(`translate ${target}: ${err}`);
        // A terminal API failure must still close this pending branch. Without
        // this, the utterance remains in memory until Stop and disappears from
        // live History. Persist it immediately as incomplete instead.
        skipTranslation(id, target);
      });
    },
    [showToast, skipTranslation, slotLabelFor],
  );

  const selectedDeviceRef = useRef(selectedDevice);
  useEffect(() => {
    selectedDeviceRef.current = selectedDevice;
  }, [selectedDevice]);

  const startInFlightRef = useRef(false);

  const openSettings = useCallback((tab: SettingsTab = "meeting") => {
    setSettingsTab(tab);
    setShowSettings(true);
    setOpenChip(null);
  }, []);

  const handleStart = useCallback(async () => {
    // Dedup rapid double-clicks / hotkey + click race — without this, a
    // second invoke during the first's await would surface "already running"
    // from the sidecar as a confusing toast.
    if (startInFlightRef.current) return;

    // Pre-flight key checks. Doing these in JS avoids spinning up the
    // recording pipeline only to have every translate fail with 401, or
    // (for openai STT) the sidecar connect with 401 leaving the UI stuck
    // on "錄音中" with empty transcript.
    try {
      const cfg = await invoke<Config>("get_config");
      if (!activeLlmKey(cfg).trim()) {
        showToast(
          "error",
          `請先在設定填入 ${cfg.api.provider === "openai" ? "OpenAI" : "Anthropic"} API key`,
          5000,
        );
        openSettings("account");
        return;
      }
      if (backendRef.current === "openai" && !cfg.api.openai_api_key.trim()) {
        showToast("error", "切到雲端辨識需要 OpenAI API key", 5000);
        openSettings("account");
        return;
      }
      if (backendRef.current === "openai" && !onlineRef.current) {
        showToast("error", "目前沒有網路，雲端辨識無法使用；請改用本機辨識", 6000);
        openSettings("meeting");
        return;
      }
      // Snapshot the freshest language selection right before recording so
      // start_stt and the translate pipeline agree on source + targets.
      applyLangCfg(cfg);
    } catch {
      // get_config really shouldn't fail here — if it does, fall through and
      // let the existing error path surface whatever happens.
    }

    startInFlightRef.current = true;
    setError(null);
    setHistory([]);
    setLatestSrc("");
    setLatestTr({});
    latestTrIdRef.current = {};
    setLagSec(null);
    try {
      let source: Source;
      if (useMicRef.current) {
        source = {
          type: "mic",
          ...(selectedDeviceRef.current ? { device: selectedDeviceRef.current } : {}),
        };
      } else {
        // Resolve the bundled demo WAV to an absolute path in Rust — the old
        // hardcoded repo-relative path only existed in dev checkouts.
        let path: string;
        try {
          path = await invoke<string>("demo_wav_path");
        } catch {
          showToast("error", "找不到內建示範音檔", 5000);
          return;
        }
        source = { type: "wav", path };
      }
      await invoke("start_stt", {
        backend: backendRef.current,
        source,
        language: langCfgRef.current.source,
      });
    } catch (err) {
      setError(`start: ${err}`);
    } finally {
      startInFlightRef.current = false;
    }
  }, [showToast, applyLangCfg, openSettings]);

  const handleCloseSettings = useCallback(async () => {
    setShowSettings(false);
    // Settings persists audio.input_device via set_config — re-read so the
    // main window's selectedDevice (used by MicMeter and start_stt) reflects
    // what the user just saved.
    try {
      const cfg = await invoke<Config>("get_config");
      setSelectedDevice(cfg.audio?.input_device ?? "");
      applyLangCfg(cfg);
    } catch {
      // Ignore — keep prior value.
    }
    refreshSlotWindows();
  }, [applyLangCfg, refreshSlotWindows]);

  const requestStart = useCallback(() => {
    if (hasHistoryRef.current) {
      setConfirmRestart(true);
    } else {
      handleStart();
    }
  }, [handleStart]);

  const handleStop = useCallback(async () => {
    try {
      // Flush any utterances still waiting on translation BEFORE stop_stt
      // finalizes meta.json — once stop_session runs the recorder slot is
      // empty and subsequent appends silently drop on the floor.
      await flushPending();
      const sessionId = await invoke<string | null>("stop_stt");
      // Drop rolling translation context so a new session doesn't carry
      // pronouns / topic from the previous meeting into its first sentence.
      invoke("clear_translation_context").catch(() => {});
      if (
        finalizedThisSessionRef.current > 0 &&
        localStorage.getItem("mc_history_coach_seen") !== "1"
      ) {
        setShowHistoryCoach(true);
      }
      // Opt-in post-meeting auto-summary. Re-read config (the user may have
      // just toggled it in Settings) and, only if the session actually
      // captured something, generate a summary per configured language. The
      // recording-stopped UI resets independently via the `stt:stopped`
      // listener — that event fires during these awaits, so the ~30s of
      // summary work below never strands the button on 停止.
      if (sessionId && finalizedThisSessionRef.current > 0) {
        let cfg: Config | null = null;
        try {
          cfg = await invoke<Config>("get_config");
        } catch {
          cfg = null;
        }
        if (cfg?.summary?.auto_generate && cfg.summary.auto_targets.length > 0) {
          showToast("info", "會議結束，自動產生總結中…完成後可在歷史會議查看", 6000);
          // Sequential (not Promise.all) so the per-language calls don't
          // collide on the Anthropic rate limit. Each target is isolated:
          // one failure toasts but doesn't abort the rest.
          for (const target of cfg.summary.auto_targets) {
            try {
              await invoke("generate_summary", {
                sessionId,
                target,
                template: cfg.summary.auto_template,
              });
            } catch {
              showToast("error", `自動總結失敗（${target}）`, 5000);
            }
          }
        }
      }
    } catch (err) {
      setError(`stop: ${err}`);
    }
  }, [flushPending, showToast]);

  // Dev-only headless automation. `VITE_MC_AUTOSTART="openai-demo:100"` (or
  // `local-demo:N`) picks the backend + the bundled demo WAV, starts once the
  // sidecar is ready and stops after N seconds — so a pipeline change can be
  // verified from session files / traces without clicking through the UI.
  // Compiled out of release builds (import.meta.env.DEV) and inert when the
  // variable is unset. Never clears its timers: the effect re-runs when
  // `handleStart`/`handleStop` identities change and must not cancel the stop.
  const autostartDoneRef = useRef(false);
  useEffect(() => {
    const spec = import.meta.env.DEV ? (import.meta.env.VITE_MC_AUTOSTART as string | undefined) : undefined;
    if (!spec || autostartDoneRef.current || !sidecarReady) return;
    const [preset, secs] = spec.split(":");
    if (preset !== "openai-demo" && preset !== "local-demo") return;
    autostartDoneRef.current = true;
    setBackend(preset === "openai-demo" ? "openai" : "local");
    setUseMic(false);
    const runMs = (parseInt(secs ?? "100", 10) || 100) * 1000;
    setTimeout(() => {
      handleStart();
    }, 800);
    setTimeout(() => {
      handleStop();
    }, 800 + runMs);
  }, [sidecarReady, handleStart, handleStop]);

  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [
      listen<TranscriptPayload>("transcript", (e) => {
        const { text, is_final, t_start, t_end } = e.payload;
        if (!text) return;
        if (is_final) {
          setLatestSrc("");
          // Lag = wall-clock since recording started minus the audio position
          // of this segment's end. Rounded to 0.1s, floored at 0.
          const t0 = sessionStartedAtRef.current;
          if (t0 != null) {
            const lag = (Date.now() - t0) / 1000 - t_end;
            setLagSec(Math.max(0, Math.round(lag * 10) / 10));
          }
          if (interpModeRef.current === "incremental") {
            // Rust translated + persisted this segment already (see
            // interp.rs). Merge it into its sentence group's line.
            const gid = e.payload.utterance_id ?? String(t_start);
            setHistory((h) => {
              const last = h[h.length - 1];
              if (last && last.id === gid) {
                return [...h.slice(0, -1), { id: gid, text: last.text + text }];
              }
              return [...h, { id: gid, text }];
            });
            finalizedThisSessionRef.current += 1;
            return;
          }
          setHistory((h) => [...h, { id: String(t_start), text }]);
          const id = String(t_start);
          const ts = enabledTargets();
          // Skip the translate call for trivially short utterances —
          // single-char fragments like "嗯", "啊", "對" are usually noise
          // or filler, and translating each one bills an API call for no
          // user value (and often produces meta-prefix-filtered junk). Also
          // covers the no-target case. Still record the source-only row so
          // the meeting transcript is faithful.
          if (text.trim().length < 2 || ts.length === 0) {
            invoke("session_append_utterance", {
              utterance: {
                id,
                t_start,
                t_end,
                src: text,
                translations: {},
                incomplete: false,
              },
            })
              .then(() => {
                finalizedThisSessionRef.current += 1;
              })
              .catch((err) => console.error("session_append_utterance:", err));
            return;
          }
          // Seat the pending entry BEFORE invoking translate so requestTranslate's
          // closed-window short-circuit can mark its lang done immediately.
          const translations: Record<
            string,
            { text: string; done: boolean; failed: boolean }
          > = {};
          for (const lang of ts) {
            translations[lang] = { text: "", done: false, failed: false };
          }
          pendingUtterancesRef.current.set(id, { src: text, t_start, t_end, translations });
          for (const lang of ts) requestTranslate(id, text, lang);
        } else {
          setLatestSrc(text);
        }
      }),
      // Static subscriptions for every registry language (chunk/replace/done).
      // Subscribing to all up front avoids a re-subscription race when the
      // target selection changes; a handler simply ignores an id whose pending
      // entry doesn't include this language.
      ...LANGS.flatMap((l) => {
        const code = l.code;
        return [
          listen<ChunkPayload>(`translation:chunk:${code}`, (e) => {
            const t = pendingUtterancesRef.current.get(e.payload.id)?.translations[code];
            if (t) t.text += e.payload.text;
            // Side thumbnail: a new id starts a fresh line, same id appends.
            const cur = latestTrIdRef.current[code];
            latestTrIdRef.current[code] = e.payload.id;
            setLatestTr((m) => ({
              ...m,
              [code]: cur === e.payload.id ? (m[code] ?? "") + e.payload.text : e.payload.text,
            }));
          }),
          // Emitted when the streaming translate broke and a non-streaming
          // retry produced the full text — REPLACE (not append) whatever
          // partial the chunk handler accumulated. done follows and finalizes.
          listen<ChunkPayload>(`translation:replace:${code}`, (e) => {
            const t = pendingUtterancesRef.current.get(e.payload.id)?.translations[code];
            if (t) t.text = e.payload.text;
            latestTrIdRef.current[code] = e.payload.id;
            setLatestTr((m) => ({ ...m, [code]: e.payload.text }));
          }),
          listen<DonePayload>(`translation:done:${code}`, (e) => {
            const t = pendingUtterancesRef.current.get(e.payload.id)?.translations[code];
            if (t) {
              t.done = true;
              tryFinalize(e.payload.id);
            }
          }),
        ];
      }),
      // Config's language selection changed. Re-read config into the ref/badge;
      // if the SOURCE changed while idle, the panel's transcript + latest line
      // are stale under the new badge — clear them. Slots-only changes leave
      // the panel alone.
      listen("language:changed", async () => {
        const prevSource = langCfgRef.current.source;
        try {
          const cfg = await invoke<Config>("get_config");
          applyLangCfg(cfg);
          if ((cfg.language?.source ?? "zh") !== prevSource && !runningRef.current) {
            setHistory([]);
            setLatestSrc("");
            setLatestTr({});
          }
        } catch {
          // Leave the prior selection in place.
        }
      }),
      // Any other config change (interp mode, appearance, models) — keep the
      // 本場設定 card current.
      listen("config:changed", async () => {
        try {
          applyLangCfg(await invoke<Config>("get_config"));
        } catch {
          // ignore
        }
      }),
      listen<{ online: boolean }>("network:status", (e) => {
        onlineRef.current = e.payload.online;
        setOnline(e.payload.online);
      }),
      listen("session:reset", () => {
        pendingUtterancesRef.current.clear();
        closedLangsNotifiedRef.current.clear();
      }),
      listen("stt:ready", () => {
        if (restartingRef.current) return;
        setSidecarReady(true);
        // `ready` only confirms the sidecar's stdin loop is alive — model and
        // mic prewarm tasks are still running in the background at this point
        // (they fire their own prewarm events). Only spawn is truly done.
        // Marking model/mic as done here would dismiss the checklist too early
        // and the user could click 開始 while the model is still loading
        // weights to GPU — first transcribe then queues behind prewarm and
        // click-to-red lag is multiple seconds. Let the per-step prewarm
        // events flip individual statuses on their own.
        setStepStatus((s) => ({ ...s, spawn: "done" }));
      }),
      listen<PrewarmPayload>("stt:prewarm", (e) => {
        if (restartingRef.current) return;
        const { step, state, message, downloaded_bytes, total_bytes, cached } =
          e.payload;
        const id = step as StepId;
        // First sidecar event of any kind also confirms the spawn step. The
        // child has reached our Python entry; the bootstrapper is past.
        setStepStatus((s) => {
          const next: Record<StepId, StepStatus> = { ...s };
          if (next.spawn !== "done") next.spawn = "done";
          // Only start/done/error change a step's status; "progress" updates
          // the byte counters below without touching the (in_progress) row.
          if (state === "start") next[id] = "in_progress";
          else if (state === "done") next[id] = "done";
          else if (state === "error") next[id] = "error";
          return next;
        });
        if (state === "error" && message) {
          setStepError((m) => ({ ...m, [id]: message }));
        }
        // Model-download progress: derive speed/ETA/stall from consecutive
        // byte samples, stash for the checklist, and clear everything once
        // the step resolves (done or error) so a stale bar never lingers.
        if (step === "model") {
          if (
            state === "progress" &&
            downloaded_bytes != null &&
            total_bytes != null
          ) {
            const now = Date.now();
            const prev = dlSampleRef.current;
            if (prev && now > prev.t) {
              const instant =
                (downloaded_bytes - prev.bytes) / ((now - prev.t) / 1000);
              // Negative deltas (cache file replaced/reset) don't feed the
              // average; the next positive sample resumes it.
              if (instant >= 0) {
                const prevEma = dlSpeedEmaRef.current;
                dlSpeedEmaRef.current =
                  prevEma == null ? instant : 0.4 * instant + 0.6 * prevEma;
              }
            }
            dlSampleRef.current = { bytes: downloaded_bytes, t: now };
            const last = dlLastIncreaseRef.current;
            if (last == null || downloaded_bytes > last.bytes) {
              dlLastIncreaseRef.current = { bytes: downloaded_bytes, t: now };
            }
            // The sidecar polls every ~2s even when no bytes land, so a hung
            // download keeps producing samples with frozen counters — 12s
            // without growth flips the row into the stalled presentation.
            const stalled =
              dlLastIncreaseRef.current != null &&
              now - dlLastIncreaseRef.current.t > 12_000;
            const ema = dlSpeedEmaRef.current;
            const etaSec =
              ema != null && ema > 0
                ? (total_bytes - downloaded_bytes) / ema
                : null;
            setModelProgress({
              downloaded: downloaded_bytes,
              total: total_bytes,
              speedBps: ema,
              etaSec,
              stalled,
            });
          } else if (state === "progress" && cached) {
            // Cache hit: weights already local, no download. Flag the load so
            // the checklist shows "已在本機" rather than a silent spinner.
            setModelCached(true);
          } else if (state === "done" || state === "error") {
            setModelProgress(null);
            setModelCached(false);
            dlSampleRef.current = null;
            dlSpeedEmaRef.current = null;
            dlLastIncreaseRef.current = null;
          }
        }
      }),
      listen("stt:started", () => {
        setRunning(true);
        const now = Date.now();
        sessionStartedAtRef.current = now;
        setSessionStartedAt(now);
        finalizedThisSessionRef.current = 0;
        if (modelTimerRef.current) {
          clearTimeout(modelTimerRef.current);
          modelTimerRef.current = null;
        }
        setModelLoading(false);
      }),
      listen("stt:stopped", () => {
        setRunning(false);
        setSessionStartedAt(null);
        setActiveSessionId(null);
      }),
      listen<string>("session:opened", (e) => {
        setActiveSessionId(e.payload);
      }),
      listen("stt:model_loading", () => {
        // Delay painting the notice so cache hits (model_ready arrives within
        // a few ms) never flash. Only a real first-run download triggers the UI.
        modelTimerRef.current = setTimeout(() => setModelLoading(true), 400);
      }),
      listen("stt:model_ready", () => {
        if (modelTimerRef.current) {
          clearTimeout(modelTimerRef.current);
          modelTimerRef.current = null;
        }
        setModelLoading(false);
      }),
      listen<string>("stt:error", (e) => setError(e.payload)),
      listen<string>("stt:warning", (e) => showToast("warning", e.payload, 6000)),
      listen<CrashPayload>("stt:crashed", (e) => {
        const { attempt, max } = e.payload;
        showToast("warning", `辨識引擎崩潰，重啟中 (${attempt}/${max})`);
      }),
      listen<RestoredPayload>("stt:restored", (e) => {
        showToast("info", `辨識引擎已重啟 (第 ${e.payload.attempt} 次)`);
      }),
      listen<string>("stt:fatal", (e) => {
        setRunning(false);
        showToast("error", e.payload, 0);
      }),
      listen<number>("stt:idle_timeout", (e) => {
        const minutes = e.payload;
        showToast("warning", `已閒置 ${minutes} 分鐘無人說話，自動停止錄音`, 8000);
        if (runningRef.current) {
          handleStop();
        }
      }),
      listen("hotkey:toggle", () => {
        if (runningRef.current) {
          handleStop();
        } else {
          requestStart();
        }
      }),
    ];

    return () => {
      // Promise-based cleanup so StrictMode double-mounts don't leave duplicate
      // listeners. If the promise hasn't resolved yet, the unlisten still fires
      // once it does.
      unlistens.forEach((p) => p.then((u) => u()));
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (modelTimerRef.current) clearTimeout(modelTimerRef.current);
    };
  }, [
    handleStop,
    requestStart,
    showToast,
    requestTranslate,
    tryFinalize,
    enabledTargets,
    applyLangCfg,
  ]);

  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history, latestSrc]);

  useEffect(() => {
    if (sessionStartedAt === null) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - sessionStartedAt);
    const id = setInterval(() => setElapsed(Date.now() - sessionStartedAt), 1000);
    return () => clearInterval(id);
  }, [sessionStartedAt]);

  const micMissing = micAvailable === false && useMic;
  const hasPrewarmError = Object.values(stepStatus).some((s) => s === "error");
  const prewarmResolved =
    sidecarReady === true &&
    (Object.values(stepStatus) as StepStatus[]).every((s) => s === "done" || s === "error");

  // While the mic is missing, re-probe whenever the window regains focus —
  // the user likely just flipped the toggle in System Settings and came
  // back. No periodic polling; focus is the only trigger.
  useEffect(() => {
    if (!micMissing) return;
    const onFocus = () => probeMic();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [micMissing, probeMic]);

  const retryPrewarm = useCallback(async () => {
    setRetryingPrewarm(true);
    setStepStatus({ spawn: "in_progress", model: "pending", mic: "pending" });
    setStepError({});
    setModelProgress(null);
    setModelCached(false);
    dlSampleRef.current = null;
    dlSpeedEmaRef.current = null;
    dlLastIncreaseRef.current = null;
    setSidecarReady(false);
    restartingRef.current = true;
    try {
      await invoke("restart_sidecar");
    } catch (e) {
      setError(`restart: ${e}`);
      // Flip the spawn row back to error so the checklist shows the red row +
      // retry button again instead of spinning on "in_progress" forever.
      setStepStatus((s) => ({ ...s, spawn: "error" }));
      setStepError((m) => ({ ...m, spawn: String(e) }));
    } finally {
      restartingRef.current = false;
      setRetryingPrewarm(false);
    }
  }, []);

  const rerunOnboarding = useCallback(async () => {
    setShowSettings(false);
    try {
      setNeedsWelcome(await invoke<Config>("get_config"));
    } catch {
      showToast("error", "無法讀取設定", 4000);
    }
  }, [showToast]);

  const openTranslationWindows = useCallback(async () => {
    const { slots } = langCfgRef.current;
    const labels: SlotLabel[] = [];
    if (slots[0]) labels.push("t1");
    if (slots[1]) labels.push("t2");
    for (const l of labels) {
      try {
        await openSlotWindow(l);
      } catch (e) {
        showToast("error", `無法開啟譯文視窗：${e}`, 5000);
      }
    }
    // A re-opened window should receive translations again.
    closedLangsNotifiedRef.current.clear();
    refreshSlotWindows();
    setOpenChip(null);
  }, [showToast, refreshSlotWindows]);

  // ---- Derived chip states ----
  const backendLabel = backend === "openai" ? "雲端" : "本機";
  const anySlotClosed = targets.some((t) => {
    const l = slotLabelFor(t);
    return l ? !slotOpen[l] : false;
  });
  const sttTone: ChipTone = hasPrewarmError
    ? "bad"
    : !prewarmResolved || modelLoading
      ? "warn"
      : backend === "openai" && !online
        ? "bad"
        : "neutral";
  const sttValue = hasPrewarmError
    ? `${backendLabel} · 啟動失敗`
    : !prewarmResolved
      ? `${backendLabel} · 準備中`
      : modelLoading
        ? `${backendLabel} · 載入模型`
        : backend === "openai" && !online
          ? "雲端 · 離線"
          : backendLabel;
  const trTone: ChipTone =
    targets.length === 0 ? "neutral" : !online ? "warn" : anySlotClosed ? "warn" : "neutral";
  const trValue =
    targets.length === 0
      ? "未設定"
      : !online
        ? "暫停，恢復後續翻"
        : anySlotClosed
          ? `${targets.join(" · ")} · 視窗已關`
          : targets.join(" · ");
  const micTone: ChipTone = !useMic ? "neutral" : micAvailable === false ? "bad" : "neutral";
  const micValue = !useMic ? "示範音檔" : micAvailable === false ? "未授權" : selectedDevice || "系統預設";
  const canStart = prewarmResolved && !hasPrewarmError;

  const costUsd = cfgSnap
    ? estimateHourlyUsd({
        provider: cfgSnap.api.provider,
        model: cfgSnap.api.model,
        openaiModel: cfgSnap.api.openai_model,
        interpIncremental: cfgSnap.interp?.mode === "incremental",
        targetCount: targets.length,
        cloudStt: backend === "openai",
      })
    : null;

  const lastFinal = history.length > 0 ? history[history.length - 1].text : "";

  return (
    <main className="relative grid h-screen grid-rows-[44px_1fr_64px] bg-paper-50 text-paper-900">
      {/* ---------- Status bar ---------- */}
      <div className="flex items-center gap-2 border-b border-paper-200 bg-white px-4">
        <span className="ai-text mr-1 text-[13px] font-bold tracking-tight">MeetingCast</span>

        <Chip
          id="rec"
          open={openChip}
          setOpen={setOpenChip}
          tone="neutral"
          lead={<span className={`inline-block h-2 w-2 rounded-full ${running ? "ai-dot" : "bg-paper-400"}`} />}
          value={running ? "錄音中" : "閒置"}
          trail={
            <span className={`font-mono text-[11px] tabular-nums ${running ? "text-paper-700" : "text-paper-500"}`}>
              {running ? formatElapsed(elapsed) : "0:00"}
            </span>
          }
        >
          <PopTitle>錄音狀態</PopTitle>
          <PopText>
            {running
              ? `已錄 ${formatElapsed(elapsed)}。逐字稿與譻文會存到這場會議，停止後可在「歷史會議」查看。`
              : "按下方「開始」或快捷鍵 ⌘ ⇧ M 開始錄音。"}
          </PopText>
          {activeSessionId && <PopMeta>場次 {activeSessionId}</PopMeta>}
        </Chip>

        <Chip
          id="mic"
          open={openChip}
          setOpen={setOpenChip}
          tone={micTone}
          label="麥克風"
          lead={useMic ? <MicMeter active={!running && useMic} deviceLabel={selectedDevice} /> : null}
          value={micValue}
        >
          <PopTitle>麥克風</PopTitle>
          {!useMic ? (
            <PopText>目前使用內建示範音檔（進階設定可切回麥克風）。</PopText>
          ) : micAvailable === false ? (
            <>
              <PopText>
                無法使用麥克風。請確認已接上，並在 系統設定 → 隱私權與安全性 → 麥克風 允許 MeetingCast。授權後若仍顯示此訊息，請重新啟動 App（macOS 限制）。
              </PopText>
              <PopActions>
                <PopButton primary onClick={() => invoke("open_mic_settings").catch(() => {})}>
                  打開系統設定
                </PopButton>
                <PopButton onClick={probeMic}>重新檢查</PopButton>
              </PopActions>
            </>
          ) : (
            <>
              <PopText>
                {selectedDevice ? `使用「${selectedDevice}」。` : "使用系統預設輸入。"}
                {running ? "錄音中音量條暫停顯示，避免與辨識引擎搶麥克風。" : "閒置時音量條會隨聲音跳動，可先確認收音。"}
              </PopText>
              <PopActions>
                <PopButton onClick={() => openSettings("meeting")}>變更裝置…</PopButton>
              </PopActions>
            </>
          )}
        </Chip>

        <Chip id="stt" open={openChip} setOpen={setOpenChip} tone={sttTone} label="辨識" value={sttValue}>
          <PopTitle>辨識引擎</PopTitle>
          <PopText>
            {backend === "openai"
              ? "OpenAI gpt-live-transcribe（雲端）：字更早上螢幕，需要網路與 OpenAI key。"
              : "本機 mlx-whisper：免費、離線可用；句尾才出字。"}
          </PopText>
          {!prewarmResolved || hasPrewarmError ? (
            <div className="mt-2">
              <PrewarmChecklist
                stepStatus={stepStatus}
                stepError={stepError}
                modelProgress={modelProgress}
                modelCached={modelCached}
              />
            </div>
          ) : null}
          <PopActions>
            {(hasPrewarmError || prewarmResolved) && (
              <PopButton onClick={retryPrewarm} disabled={retryingPrewarm || running}>
                {retryingPrewarm ? "重新啟動中…" : hasPrewarmError ? "重試" : "重新啟動引擎"}
              </PopButton>
            )}
            <PopButton onClick={() => openSettings("meeting")} disabled={running}>
              變更…
            </PopButton>
          </PopActions>
        </Chip>

        <Chip id="tr" open={openChip} setOpen={setOpenChip} tone={trTone} label="翻譯" value={trValue}>
          <PopTitle>翻譯</PopTitle>
          {targets.length === 0 ? (
            <PopText>尚未選擇譯文語言。到「會議設定」選一或兩個語言，各自顯示在一個譯文視窗。</PopText>
          ) : (
            <PopText>
              {targets.map(zhName).join("、")}
              {cfgSnap?.interp?.mode === "incremental" ? " · 同步口譯模式" : " · 逐句翻譯"}。
              {!online
                ? " 目前沒有網路，翻譯暫停；逐字稿照常進行，網路恢復後新句子會自動翻譯。"
                : anySlotClosed
                  ? " 有譯文視窗被關閉，該語言暫不翻譯（不計費）。"
                  : " 譯文會串流到各自的視窗。"}
            </PopText>
          )}
          <PopActions>
            <PopButton primary onClick={openTranslationWindows} disabled={targets.length === 0}>
              開啟譯文視窗
            </PopButton>
            <PopButton onClick={() => openSettings("meeting")} disabled={running}>
              變更…
            </PopButton>
          </PopActions>
        </Chip>

        <Chip
          id="net"
          open={openChip}
          setOpen={setOpenChip}
          tone={online ? "neutral" : "bad"}
          label="網路"
          value={online ? "線上" : "離線"}
        >
          <PopTitle>網路</PopTitle>
          <PopText>
            {online
              ? "可連到翻譯服務。每 20 秒檢查一次。"
              : backend === "openai"
                ? "連不到翻譯服務。雲端辨識與翻譯都無法使用；請切到本機辨識，至少保留逐字稿。"
                : "連不到翻譻服務。本機辨識照常，翻譯暫停；恢復後自動繼續。每 5 秒重試。"}
          </PopText>
          <PopActions>
            <PopButton
              primary
              onClick={() =>
                invoke<boolean>("network_probe_now")
                  .then((o) => {
                    onlineRef.current = o;
                    setOnline(o);
                  })
                  .catch(() => {})
              }
            >
              重新檢查
            </PopButton>
          </PopActions>
        </Chip>

        <span className="flex-1" />

        <Chip
          id="lag"
          open={openChip}
          setOpen={setOpenChip}
          tone={lagSec != null && lagSec > 4 ? "warn" : "neutral"}
          label="落後"
          value={lagSec != null ? `${lagSec.toFixed(1)} s` : "—"}
          mono
          alignRight
        >
          <PopTitle>落後秒數</PopTitle>
          <PopText>
            最近一句逐字稿出現時，距離它實際被說出的時間。本機辨識約 1–2 秒，雲端約 1 秒；超過 4 秒會轉黃，通常是電腦忙或網路慢。
          </PopText>
        </Chip>
      </div>

      {/* ---------- Body ---------- */}
      <div className="grid min-h-0 grid-cols-[1fr_300px]">
        {/* Transcript */}
        <section className="flex min-h-0 flex-col border-r border-paper-200">
          {error && !isOfflineError(error) && (() => {
            const f = friendly(error);
            return (
              <div className="mx-5 mt-4 rounded-xl border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-900">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="font-medium">{f.primary}</p>
                    {f.secondary && <p className="mt-0.5 text-xs text-danger-700">{f.secondary}</p>}
                  </div>
                  <button
                    className="text-xs text-danger-700 hover:text-danger-900"
                    onClick={() => setError(null)}
                    aria-label="關閉"
                  >
                    ✕
                  </button>
                </div>
                {f.primary !== f.raw && (
                  <details className="mt-1 text-xs text-danger-700">
                    <summary className="cursor-pointer hover:text-danger-900">技術細節</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-danger-100 p-2 font-mono text-[10px]">
                      {f.raw}
                    </pre>
                  </details>
                )}
              </div>
            );
          })()}

          <div className="flex flex-shrink-0 items-center gap-2 px-6 pb-2 pt-5 text-[11px] font-medium uppercase tracking-[0.12em] text-paper-600">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${running ? "ai-dot" : "bg-paper-400"}`} />
            即時逐字稿
            <span className="rounded-full bg-paper-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-paper-700">
              {zhName(sourceLang)}
            </span>
          </div>

          <div ref={historyRef} className="flex-1 overflow-y-auto px-6 pb-6">
            {history.length === 0 && !latestSrc ? (
              !prewarmResolved || hasPrewarmError ? (
                <div className="flex h-full flex-col items-center justify-center">
                  <div className="w-[320px] rounded-2xl border border-paper-200 bg-white px-6 py-5 shadow-sm">
                    <p className="mb-4 text-center font-medium text-paper-900">
                      {hasPrewarmError ? "辨識引擎啟動失敗" : "正在啟動辨識引擎"}
                    </p>
                    <PrewarmChecklist
                      stepStatus={stepStatus}
                      stepError={stepError}
                      modelProgress={modelProgress}
                      modelCached={modelCached}
                    />
                    {hasPrewarmError ? (
                      <div className="mt-4 flex flex-col items-center gap-2">
                        <button
                          className="rounded-lg bg-paper-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-paper-800 disabled:bg-paper-400"
                          onClick={retryPrewarm}
                          disabled={retryingPrewarm}
                          type="button"
                        >
                          {retryingPrewarm ? "重新啟動中…" : "重試"}
                        </button>
                        <p className="text-center text-[11px] text-paper-500">
                          首次啟動需下載約 1.5 GB；網路不穩可重試
                        </p>
                      </div>
                    ) : (
                      <p className="mt-4 text-center text-[11px] text-paper-500">
                        首次啟動需下載約 1.5 GB 語音模型，之後直接讀取快取
                      </p>
                    )}
                  </div>
                </div>
              ) : running ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-paper-600">
                  <span className="ai-dot inline-block h-3 w-3 rounded-full" />
                  <p className="text-sm font-medium text-paper-700">
                    {modelLoading ? "正在準備辨識模型，首次需要多等一下…" : "聆聽中…請開始說話"}
                  </p>
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-paper-600">
                  <p className="text-base">按「開始」後，你說的話會在這裡逐句出現。</p>
                  <p className="text-xs text-paper-500">
                    也可用快捷鍵{" "}
                    <kbd className="rounded border border-paper-300 bg-paper-100 px-1.5 py-0.5 font-mono text-[10px] text-paper-700">
                      ⌘ ⇧ M
                    </kbd>{" "}
                    切換
                    {micMissing && "；麥克風尚未授權，點上方「麥克風」處理"}
                  </p>
                </div>
              )
            ) : (
              <ul
                className="flex min-h-full flex-col justify-end space-y-2.5 text-xl leading-[1.55] select-text"
                onContextMenu={handleTranscriptContextMenu}
              >
                {history.map((h, i) => (
                  <li
                    key={h.id}
                    className={
                      i === history.length - 1 && !latestSrc
                        ? "font-medium text-paper-900"
                        : "text-paper-600"
                    }
                  >
                    {h.text}
                  </li>
                ))}
                {latestSrc && <li className="ai-caret text-paper-400">{latestSrc}</li>}
              </ul>
            )}
          </div>
        </section>

        {/* Side column */}
        <aside className="grid min-h-0 grid-rows-[auto_1fr]">
          <div className="border-b border-paper-200 bg-white px-[18px] py-4">
            <h3 className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-paper-600">
              本場設定
            </h3>
            <dl className="grid grid-cols-[52px_1fr] gap-x-2.5 gap-y-1.5 text-[13px]">
              <dt className="text-paper-500">來源</dt>
              <dd className="flex items-center gap-1.5 text-paper-900">
                {zhName(sourceLang)}
                <EditLink onClick={() => openSettings("meeting")} disabled={running} />
              </dd>
              <dt className="text-paper-500">譯文</dt>
              <dd className="flex items-center gap-1.5 text-paper-900">
                {targets.length ? targets.map(nativeName).join(" · ") : "未設定"}
                <EditLink onClick={() => openSettings("meeting")} disabled={running} />
              </dd>
              <dt className="text-paper-500">引擎</dt>
              <dd className="flex items-center gap-1.5 text-paper-900">
                {backend === "openai" ? "雲端（OpenAI）" : "本機（離線可用）"}
                <EditLink onClick={() => openSettings("meeting")} disabled={running} />
              </dd>
              <dt className="text-paper-500">麥克風</dt>
              <dd className="truncate text-paper-900" title={micValue}>
                {micValue}
              </dd>
              <dt className="text-paper-500">估算</dt>
              <dd
                className="font-mono text-[12px] tabular-nums text-paper-900"
                title="翻譯（＋雲端辨識）費用概估，每小時約 30 分鐘語音"
              >
                {formatUsd(costUsd)} / 小時
              </dd>
            </dl>
            <div className="mt-3 flex gap-2">
              <button
                className="flex-1 rounded-lg border border-paper-200 bg-white px-2 py-1.5 text-xs text-paper-800 hover:bg-paper-50 disabled:opacity-50"
                onClick={openTranslationWindows}
                disabled={targets.length === 0}
                type="button"
                title={anySlotClosed ? "重新開啟被關閉的譯文視窗" : "把譯文視窗帶到最前面"}
              >
                開啟譯文視窗 ↗
              </button>
              <button
                className="flex-1 rounded-lg border border-paper-200 bg-white px-2 py-1.5 text-xs text-paper-800 hover:bg-paper-50"
                onClick={() => openSettings("meeting")}
                type="button"
              >
                會議設定…
              </button>
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-3 overflow-hidden px-[18px] py-3.5">
            {targets.map((t) => (
              <div key={t} className="grid grid-cols-[26px_1fr] gap-2 text-[13px] leading-normal text-paper-700">
                <span className="pt-0.5 font-mono text-[11px] text-paper-500">{t}</span>
                <span className="line-clamp-3">{latestTr[t] || "—"}</span>
              </div>
            ))}
            {targets.length === 0 && (
              <p className="text-xs text-paper-500">各語言最近一句譻文會顯示在這裡。</p>
            )}
          </div>
        </aside>
      </div>

      {/* ---------- Bottom bar ---------- */}
      <div className="flex items-center gap-2.5 border-t border-paper-200 bg-white px-4">
        <button
          className={`inline-flex h-11 items-center gap-2.5 rounded-xl px-7 text-base font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 ${
            running ? "bg-recording" : "ai-fill shadow-[0_6px_18px_-8px_rgba(191,90,242,0.7)]"
          }`}
          onClick={running ? handleStop : requestStart}
          disabled={!running && !canStart}
          aria-label={running ? "停止錄音" : "開始錄音"}
          type="button"
        >
          <span className={`inline-block h-2.5 w-2.5 bg-white ${running ? "rounded-[2px]" : "rounded-full"}`} />
          {running ? "停止" : canStart ? "開始" : "準備中…"}
        </button>
        <TextButton onClick={() => setShowHistory(true)} highlight={showHistoryCoach}>
          <HistoryIcon />
          歷史會議
        </TextButton>
        <TextButton onClick={() => setShowGlossary(true)}>
          <GlossaryIcon />
          術語表
        </TextButton>
        <TextButton onClick={() => openSettings("meeting")}>
          <SettingsIcon />
          設定
        </TextButton>
        <span className="ml-auto rounded border border-paper-200 px-1.5 py-px font-mono text-[11px] text-paper-500">
          ⌘ ⇧ M
        </span>
      </div>

      {showHistoryCoach && (
        <div className="absolute bottom-[72px] left-[150px] z-30 w-64 rounded-2xl bg-paper-900 px-4 py-3 text-paper-50 shadow-xl">
          <span className="absolute -bottom-1.5 left-10 h-3 w-3 rotate-45 bg-paper-900" />
          <p className="text-sm font-medium leading-snug">第一場會議已存好</p>
          <p className="mt-1 text-xs leading-relaxed text-paper-300">
            打開「歷史會議」可以重看逐字稿、匯出，或讓 AI 產生會議總結
          </p>
          <div className="mt-3 flex justify-end gap-2 text-xs">
            <button
              className="rounded-full px-3 py-1 text-paper-300 transition hover:text-paper-50"
              onClick={() => {
                localStorage.setItem("mc_history_coach_seen", "1");
                setShowHistoryCoach(false);
              }}
            >
              知道了
            </button>
            <button
              className="rounded-full bg-paper-50 px-3 py-1 font-medium text-paper-900 transition hover:bg-paper-200"
              onClick={() => {
                localStorage.setItem("mc_history_coach_seen", "1");
                setShowHistoryCoach(false);
                setShowHistory(true);
              }}
            >
              看看
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`pointer-events-auto fixed right-4 top-[52px] z-20 max-w-xs rounded-xl border px-4 py-2.5 text-sm shadow-lg ${
            toast.kind === "error"
              ? "border-danger-200 bg-danger-50 text-danger-900"
              : toast.kind === "warning"
                ? "border-warn-200 bg-warn-50 text-warn-900"
                : "border-paper-200 bg-white text-paper-700"
          }`}
          onClick={() => setToast(null)}
        >
          {toast.message}
        </div>
      )}

      {showSettings && (
        <SettingsModal
          onClose={handleCloseSettings}
          backend={backend}
          setBackend={setBackend}
          useMic={useMic}
          setUseMic={setUseMic}
          running={running}
          initialTab={settingsTab}
          onRerunChecklist={() => {
            setShowSettings(false);
            retryPrewarm();
          }}
          onRerunOnboarding={rerunOnboarding}
        />
      )}

      {showHistory && (
        <HistoryModal
          onClose={() => setShowHistory(false)}
          activeSessionId={activeSessionId}
        />
      )}

      {showGlossary && (
        <GlossaryModal
          onClose={() => {
            setShowGlossary(false);
            setPendingGlossaryTerm(null);
          }}
          initialTerm={pendingGlossaryTerm}
        />
      )}

      {transcriptMenu && (
        <div
          className="fixed z-40 min-w-[140px] overflow-hidden rounded-lg border border-paper-200 bg-white py-1 shadow-xl"
          style={{ left: transcriptMenu.x, top: transcriptMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full px-3 py-1.5 text-left text-sm text-paper-900 hover:bg-paper-100"
            onClick={() => addToGlossary(transcriptMenu.text)}
          >
            加入術語表
            <span className="ml-1 text-xs text-paper-500">「{transcriptMenu.text.slice(0, 12)}」</span>
          </button>
        </div>
      )}

      {needsWelcome && (
        <WelcomeWizard
          initialConfig={needsWelcome}
          onDone={async () => {
            setNeedsWelcome(null);
            try {
              const cfg = await invoke<Config>("get_config");
              setSelectedDevice(cfg.audio?.input_device ?? "");
              applyLangCfg(cfg);
            } catch {
              // ignore
            }
            refreshSlotWindows();
          }}
          stepStatus={stepStatus}
          stepError={stepError}
          modelProgress={modelProgress}
          modelCached={modelCached}
          retryPrewarm={retryPrewarm}
          micAvailable={micAvailable}
          probeMic={probeMic}
          backend={backend}
          setBackend={setBackend}
          running={running}
          startTest={handleStart}
          stopTest={handleStop}
          latestSrc={latestSrc}
          lastFinal={lastFinal}
          latestTranslations={latestTr}
          lagSec={lagSec}
          online={online}
        />
      )}

      {confirmRestart && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-paper-900/30 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-paper-200 bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-paper-900">開始新的錄音？</h2>
            <p className="mt-2 text-sm text-paper-600">{restartClearNotice()}</p>
            <footer className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-lg px-3 py-1.5 text-sm text-paper-600 hover:bg-paper-100"
                onClick={() => setConfirmRestart(false)}
              >
                取消
              </button>
              <button
                className="rounded-lg bg-paper-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-paper-800"
                onClick={() => {
                  setConfirmRestart(false);
                  handleStart();
                }}
                autoFocus
              >
                確定
              </button>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}

// ---------- Small presentational pieces ----------

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: "border-paper-200 bg-paper-50 text-paper-700",
  ok: "border-ok-200 bg-ok-50 text-ok-900",
  warn: "border-warn-200 bg-warn-50 text-warn-900",
  bad: "border-danger-200 bg-danger-50 text-danger-900",
};
const TONE_VALUE_CLASS: Record<ChipTone, string> = {
  neutral: "text-paper-900",
  ok: "text-ok-900",
  warn: "text-warn-900",
  bad: "text-danger-900",
};

/** A status-bar chip with a click-to-open explanation / action popover. */
function Chip({
  id,
  open,
  setOpen,
  tone,
  label,
  lead,
  value,
  trail,
  mono,
  alignRight,
  children,
}: {
  id: ChipId;
  open: ChipId | null;
  setOpen: (v: ChipId | null) => void;
  tone: ChipTone;
  label?: string;
  lead?: React.ReactNode;
  value: string;
  trail?: React.ReactNode;
  mono?: boolean;
  alignRight?: boolean;
  children: React.ReactNode;
}) {
  const isOpen = open === id;
  return (
    <span className="relative inline-flex" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ai-blue/40 ${TONE_CLASS[tone]} ${
          isOpen ? "ring-2 ring-paper-300" : ""
        }`}
        onClick={() => setOpen(isOpen ? null : id)}
        aria-expanded={isOpen}
        aria-label={label ? `${label}：${value}` : value}
      >
        {lead}
        {label && <span className="text-[11px] text-paper-500">{label}</span>}
        <span className={`font-medium ${mono ? "font-mono tabular-nums" : ""} ${TONE_VALUE_CLASS[tone]}`}>{value}</span>
        {trail}
      </button>
      {isOpen && (
        <div
          className={`absolute top-full z-40 mt-1.5 w-72 rounded-xl border border-paper-200 bg-white p-3.5 text-left shadow-xl ${
            alignRight ? "right-0" : "left-0"
          }`}
          role="dialog"
        >
          {children}
        </div>
      )}
    </span>
  );
}

function PopTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] font-semibold text-paper-900">{children}</p>;
}
function PopText({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs leading-relaxed text-paper-600">{children}</p>;
}
function PopMeta({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 font-mono text-[10px] text-paper-500">{children}</p>;
}
function PopActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2.5 flex flex-wrap gap-2">{children}</div>;
}
function PopButton({
  primary,
  disabled,
  onClick,
  children,
}: {
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rounded-lg px-2.5 py-1 text-xs disabled:opacity-50 ${
        primary
          ? "bg-paper-900 font-medium text-white hover:bg-paper-800"
          : "border border-paper-200 text-paper-800 hover:bg-paper-50"
      }`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function EditLink({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="text-[11px] text-ai-blue hover:underline disabled:cursor-not-allowed disabled:text-paper-400 disabled:no-underline"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "錄音中無法變更" : undefined}
    >
      變更
    </button>
  );
}

function TextButton({
  onClick,
  highlight,
  children,
}: {
  onClick: () => void;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-paper-700 transition hover:bg-paper-100 hover:text-paper-900 ${
        highlight ? "ring-2 ring-ai-violet/60 ring-offset-2 ring-offset-white" : ""
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
