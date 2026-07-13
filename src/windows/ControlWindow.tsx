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
import { friendly } from "@/lib/errors";
import { LANGS, zhName } from "@/lib/languages";
import type {
  ChunkPayload,
  Config,
  DonePayload,
  Source,
  TranscriptPayload,
} from "@/lib/types";

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

function SettingsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function GlossaryIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function HistoryIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  );
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
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
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
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
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
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live language selection (source + two target slots). Kept in a ref so
  // event handlers read the current value without re-subscribing; the source
  // is mirrored into `sourceLang` state for the badge.
  const langCfgRef = useRef<{ source: string; slots: [string, string] }>({
    source: "zh",
    slots: ["en", "vi"],
  });
  const applyLangCfg = useCallback((cfg: Config) => {
    const source = cfg.language?.source ?? "zh";
    const slots = cfg.language?.target_slots ?? ["en", "vi"];
    langCfgRef.current = { source, slots: [slots[0] ?? "", slots[1] ?? ""] };
    setSourceLang(source);
  }, []);
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
  // Which window label carries a target language, or null if neither slot does.
  const slotLabelFor = useCallback((lang: string): "t1" | "t2" | null => {
    const { slots } = langCfgRef.current;
    if (slots[0] === lang) return "t1";
    if (slots[1] === lang) return "t2";
    return null;
  }, []);
  const restartClearNotice = (): string => {
    const src = zhName(langCfgRef.current.source);
    const targets = enabledTargets();
    return targets.length === 0
      ? `繼續會清除目前的${src}逐字稿與譯文。`
      : `繼續會清除目前的${src}逐字稿與${targets.map(zhName).join("／")}譯文。`;
  };

  useEffect(() => {
    // First-run detection: show wizard until onboarding has been completed
    // (or skipped) once. Existing users who already have a key configured
    // never see it; a keyless skip isn't re-nagged on the next launch.
    invoke<Config>("get_config")
      .then((cfg) => {
        if (!cfg.onboarding_complete && !cfg.api.anthropic_api_key.trim()) {
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
  }, [applyLangCfg]);

  // Probe microphone permission / availability. getUserMedia triggers
  // macOS's privacy prompt for the .app bundle; once granted, the sidecar
  // subprocess inherits permission and opens its own InputStream without
  // re-prompting. We immediately stop the tracks because we only needed
  // the permission, not the audio data. Reused by the mount effect, the
  // banner's 重新檢查 button, and the window-focus re-check.
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
        // User denied or no mic device — show banner so they can fix.
        setMicAvailable(false);
      });
  }, []);

  useEffect(() => {
    // Acquire microphone permission AT APP LAUNCH instead of on the user's
    // first 開始錄音 click.
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

  // Click anywhere outside dismisses the floating context menu. Use mousedown
  // so the menu closes before a re-click on transcript text re-selects.
  useEffect(() => {
    if (!transcriptMenu) return;
    const close = () => setTranscriptMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [transcriptMenu]);

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

  const requestTranslate = useCallback(
    async (id: string, text: string, target: string) => {
      const slotLabel = slotLabelFor(target);
      const win = slotLabel ? await WebviewWindow.getByLabel(slotLabel) : null;
      if (!win) {
        if (!closedLangsNotifiedRef.current.has(target)) {
          closedLangsNotifiedRef.current.add(target);
          showToast("warning", `${zhName(target)}譯文視窗已關閉，將不再翻譯該語言`);
        }
        // Mark this lang as "done" in the pending entry so the finalizer
        // doesn't wait forever for a translation that will never arrive.
        const u = pendingUtterancesRef.current.get(id);
        if (u && u.translations[target]) {
          u.translations[target].done = true;
          tryFinalize(id);
        }
        return;
      }
      invoke("translate", { id, text, target }).catch((err) => {
        setError(`translate ${target}: ${err}`);
        // A terminal API failure must still close this pending branch. Without
        // this, the utterance remains in memory until Stop and disappears from
        // live History. Persist it immediately as incomplete instead.
        const u = pendingUtterancesRef.current.get(id);
        const translation = u?.translations[target];
        if (translation) {
          translation.failed = true;
          translation.done = true;
          tryFinalize(id);
        }
      });
    },
    [showToast, tryFinalize, slotLabelFor],
  );

  const selectedDeviceRef = useRef(selectedDevice);
  useEffect(() => {
    selectedDeviceRef.current = selectedDevice;
  }, [selectedDevice]);

  const startInFlightRef = useRef(false);

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
      if (!cfg.api.anthropic_api_key.trim()) {
        showToast("error", "請先在設定填入 Anthropic API key", 5000);
        setShowSettings(true);
        return;
      }
      if (backendRef.current === "openai" && !cfg.api.openai_api_key.trim()) {
        showToast("error", "切到 openai 辨識需要 OpenAI API key", 5000);
        setShowSettings(true);
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
  }, [showToast, applyLangCfg]);

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
  }, [applyLangCfg]);

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
      // summary work below never strands the button on 停止錄音.
      if (sessionId && finalizedThisSessionRef.current > 0) {
        let cfg: Config | null = null;
        try {
          cfg = await invoke<Config>("get_config");
        } catch {
          cfg = null;
        }
        if (cfg?.summary?.auto_generate && cfg.summary.auto_targets.length > 0) {
          showToast("info", "會議結束，自動產生總結中…完成後可在歷史紀錄查看", 6000);
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

  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [
      listen<TranscriptPayload>("transcript", (e) => {
        const { text, is_final, t_start, t_end } = e.payload;
        if (!text) return;
        if (is_final) {
          setHistory((h) => [...h, text]);
          setLatestSrc("");
          const id = String(t_start);
          const targets = enabledTargets();
          // Skip the translate call for trivially short utterances —
          // single-char fragments like "嗯", "啊", "對" are usually noise
          // or filler, and translating each one bills an API call for no
          // user value (and often produces meta-prefix-filtered junk). Also
          // covers the no-target case. Still record the source-only row so
          // the meeting transcript is faithful.
          if (text.trim().length < 2 || targets.length === 0) {
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
          for (const lang of targets) {
            translations[lang] = { text: "", done: false, failed: false };
          }
          pendingUtterancesRef.current.set(id, { src: text, t_start, t_end, translations });
          for (const lang of targets) requestTranslate(id, text, lang);
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
          }),
          // Emitted when the streaming translate broke and a non-streaming
          // retry produced the full text — REPLACE (not append) whatever
          // partial the chunk handler accumulated. done follows and finalizes.
          listen<ChunkPayload>(`translation:replace:${code}`, (e) => {
            const t = pendingUtterancesRef.current.get(e.payload.id)?.translations[code];
            if (t) t.text = e.payload.text;
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
          }
        } catch {
          // Leave the prior selection in place.
        }
      }),
      listen("session:reset", () => {
        pendingUtterancesRef.current.clear();
        closedLangsNotifiedRef.current.clear();
      }),
      listen("stt:ready", () => {
        setSidecarReady(true);
        // `ready` only confirms the sidecar's stdin loop is alive — model and
        // mic prewarm tasks are still running in the background at this point
        // (they fire their own prewarm events). Only spawn is truly done.
        // Marking model/mic as done here would dismiss the overlay too early
        // and the user could click 開始錄音 while the model is still loading
        // weights to GPU — first transcribe then queues behind prewarm and
        // click-to-red lag is multiple seconds. Let the per-step prewarm
        // events flip individual statuses on their own.
        setStepStatus((s) => ({ ...s, spawn: "done" }));
      }),
      listen<PrewarmPayload>("stt:prewarm", (e) => {
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
        setSessionStartedAt(Date.now());
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
        // Delay painting the overlay so cache hits (model_ready arrives within
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
  }, [history]);

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

  // While the mic banner is showing, re-probe whenever the window regains
  // focus — the user likely just flipped the toggle in System Settings and
  // came back. No periodic polling; focus is the only trigger.
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
    try {
      await invoke("restart_sidecar");
    } catch (e) {
      setError(`restart: ${e}`);
      // Flip the spawn row back to error so the overlay shows the red row +
      // retry button again instead of spinning on "in_progress" forever.
      setStepStatus((s) => ({ ...s, spawn: "error" }));
      setStepError((m) => ({ ...m, spawn: String(e) }));
    } finally {
      setRetryingPrewarm(false);
    }
  }, []);

  return (
    <main className="relative flex h-screen flex-col bg-paper-50 text-paper-900">

      {micMissing && (
        <div className="mx-4 mb-3 rounded-2xl border border-warn-200 bg-warn-50 px-4 py-3 text-sm">
          <p className="font-medium text-warn-900">無法使用麥克風</p>
          <p className="mt-0.5 text-xs text-warn-700">
            請確認麥克風已接上，並在 系統設定 → 隱私權與安全性 → 麥克風 允許
            MeetingCast。授權後若仍顯示此訊息，請重新啟動 App（macOS 的限制）。
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded border border-warn-200 bg-white px-2.5 py-1 text-xs font-medium text-warn-900 hover:bg-warn-50"
              onClick={() => invoke("open_mic_settings").catch(() => {})}
              type="button"
            >
              打開系統設定
            </button>
            <button
              className="rounded border border-warn-200 px-2.5 py-1 text-xs text-warn-700 hover:bg-warn-50 hover:text-warn-900"
              onClick={probeMic}
              type="button"
            >
              重新檢查
            </button>
          </div>
        </div>
      )}

      <div className="mx-4 mb-3 mt-3 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-paper-600">
          <span className="relative inline-flex h-1.5 w-1.5 items-center justify-center">
            <span
              className={`relative inline-block h-1.5 w-1.5 rounded-full ${
                running ? "bg-recording" : "bg-paper-300"
              }`}
            />
            {running && (
              <span className="absolute inline-block h-1.5 w-1.5 animate-ping rounded-full bg-recording/60" />
            )}
          </span>
          <span className={running ? "font-medium text-paper-900" : ""}>
            {running ? "錄音中" : "閒置"}
          </span>
          {/* MicMeter opens its own Web Audio mic stream to compute level,
              which on some Macs (notably M4 + Sequoia) conflicts with the
              sidecar's concurrent PortAudio open — CoreAudio routes audio
              to one client and the other gets silence, killing VAD and
              producing no transcripts. So only run MicMeter when idle: it
              becomes a "press 開始錄音 to start" pre-flight check that mic
              is actually capturing. During recording, the pulsing red dot
              + 錄音中 text + timer is enough live feedback. */}
          <MicMeter active={!running && useMic} deviceLabel={selectedDevice} />
        </span>
        <span className="flex items-center gap-3">
          <span
            className={`font-mono tabular-nums ${
              running ? "text-paper-900" : "text-paper-400"
            }`}
          >
            {running ? formatElapsed(elapsed) : "0:00"}
          </span>
          <IconButton
            label="歷史會議"
            onClick={() => setShowHistory(true)}
            highlightRing={showHistoryCoach}
          >
            <HistoryIcon className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="術語表"
            onClick={() => setShowGlossary(true)}
          >
            <GlossaryIcon className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="設定"
            onClick={() => setShowSettings(true)}
          >
            <SettingsIcon className="h-4 w-4" />
          </IconButton>
        </span>
      </div>

      {showHistoryCoach && (
        <div className="absolute right-3 top-10 z-30 w-64 rounded-2xl bg-paper-900 px-4 py-3 text-paper-50 shadow-xl">
          <span className="absolute -top-1.5 right-12 h-3 w-3 rotate-45 bg-paper-900" />
          <p className="text-sm font-medium leading-snug">
            ✨ 第一場會議已存好
          </p>
          <p className="mt-1 text-xs leading-relaxed text-paper-300">
            點右上角圖示打開歷史紀錄，可以重看逐字稿、匯出，或讓 AI 產生會議總結
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

      <button
        className="group relative mx-4 h-16 overflow-hidden rounded-2xl text-white transition active:scale-[0.99]"
        style={{
          background: running ? "#8B3A2B" : "#2A2018",
          boxShadow: running
            ? "0 6px 20px -10px rgba(139,58,43,0.4), inset 0 1px 0 rgba(255,255,255,0.08)"
            : "0 6px 20px -10px rgba(42,32,24,0.5), inset 0 1px 0 rgba(255,255,255,0.08)",
        }}
        onClick={running ? handleStop : requestStart}
        aria-label={running ? "停止錄音" : "開始錄音"}
      >
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-black/25" />
        <span className="relative flex h-full items-center justify-center text-lg font-medium tracking-[0.2em]">
          {running ? "停止錄音" : "開始錄音"}
        </span>
      </button>

      {error && (() => {
        const f = friendly(error);
        return (
          <div className="mx-4 mt-3 rounded-2xl border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-900 shadow-sm">
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

      <section className="mx-4 mb-4 mt-3 flex flex-1 flex-col overflow-hidden rounded-2xl border border-paper-200 bg-white shadow-sm">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-paper-200 px-5 py-3 text-[11px] font-medium uppercase tracking-wider text-paper-600">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-paper-500" />
          原文逐字稿
          <span className="rounded-full bg-paper-200 px-1.5 py-0.5 text-[10px] font-medium text-paper-700">
            {zhName(sourceLang)}
          </span>
        </div>
        <div ref={historyRef} className="flex-1 overflow-y-auto px-5 py-4">
          {history.length === 0 && !latestSrc ? (
            running ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-paper-600">
                <span className="relative inline-flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-recording/60" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-recording" />
                </span>
                <p className="text-sm font-medium text-paper-700">聆聽中…請開始說話</p>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-paper-600">
                <p className="text-sm">按「開始錄音」即可錄音翻譯</p>
                <p className="text-xs text-paper-500">
                  也可用快捷鍵{" "}
                  <kbd className="rounded border border-paper-300 bg-paper-100 px-1.5 py-0.5 font-mono text-[10px] text-paper-700">
                    ⌘ Shift M
                  </kbd>{" "}
                  切換
                </p>
              </div>
            )
          ) : (
            <ul
              className="space-y-2 text-base leading-relaxed text-paper-900"
              onContextMenu={handleTranscriptContextMenu}
            >
              {history.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
              {latestSrc && <li className="italic text-paper-500">{latestSrc}</li>}
            </ul>
          )}
        </div>
      </section>

      {toast && (
        <div
          className={`pointer-events-auto fixed right-4 top-4 z-20 max-w-xs rounded-xl border px-4 py-2.5 text-sm shadow-lg ${
            toast.kind === "error"
              ? "border-danger-200 bg-danger-50 text-danger-900"
              : toast.kind === "warning"
                ? "border-warn-200 bg-warn-50 text-warn-900"
                : "border-paper-300 bg-paper-100 text-paper-700"
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
          onDone={() => setNeedsWelcome(null)}
          stepStatus={stepStatus}
          stepError={stepError}
          modelProgress={modelProgress}
          modelCached={modelCached}
          retryPrewarm={retryPrewarm}
          micAvailable={micAvailable}
        />
      )}

      {confirmRestart && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-paper-900/30 p-4">
          <div className="w-full max-w-sm rounded-lg border border-paper-200 bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-paper-900">開始新的錄音？</h2>
            <p className="mt-2 text-sm text-paper-600">{restartClearNotice()}</p>
            <footer className="mt-5 flex justify-end gap-2">
              <button
                className="rounded px-3 py-1.5 text-sm text-paper-600 hover:bg-paper-100"
                onClick={() => setConfirmRestart(false)}
              >
                取消
              </button>
              <button
                className="rounded bg-paper-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-paper-700"
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

      {modelLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper-900/30 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-paper-200 bg-white px-8 py-6 shadow-xl">
            <div className="flex items-center gap-3">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-paper-200 border-t-paper-900" />
              <p className="font-medium text-paper-900">正在準備辨識模型</p>
            </div>
            <p className="max-w-xs text-center text-xs text-paper-600">
              首次啟動需下載約 1.6 GB（mlx-whisper large-v3-turbo）。下次直接使用快取，這只是首次需要等。
            </p>
          </div>
        </div>
      )}

      {(() => {
        if (modelLoading || needsWelcome) return null;
        // Show overlay until every prewarm step has resolved (done or
        // error). Previously this gated only on `sidecarReady`, but ready
        // fires the moment the sidecar's stdin loop comes up — model and
        // mic prewarm tasks run in the background and may take 5–30 s to
        // finish. Dismissing too early let users press 開始錄音 while the
        // model was still loading weights to GPU; first transcribe then
        // queued behind prewarm and click-to-red took several seconds.
        if (sidecarReady !== true) return true;
        const allResolved = (Object.values(stepStatus) as StepStatus[]).every(
          (s) => s === "done" || s === "error",
        );
        return !allResolved;
      })() && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper-900/30 backdrop-blur-sm">
          <div className="w-[300px] rounded-2xl border border-paper-200 bg-white px-6 py-5 shadow-xl">
            <p className="mb-4 text-center font-medium text-paper-900">正在啟動辨識引擎</p>
            <PrewarmChecklist
              stepStatus={stepStatus}
              stepError={stepError}
              modelProgress={modelProgress}
              modelCached={modelCached}
            />
            {hasPrewarmError ? (
              <div className="mt-4 flex flex-col items-center gap-2">
                <button
                  className="rounded bg-paper-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-paper-700 disabled:bg-paper-400"
                  onClick={retryPrewarm}
                  disabled={retryingPrewarm}
                  type="button"
                >
                  {retryingPrewarm ? "重新啟動中…" : "重試"}
                </button>
                <p className="text-center text-[11px] text-paper-500">
                  首次啟動需下載約 1.6 GB；網路不穩可重試
                </p>
              </div>
            ) : (
              <p className="mt-4 text-center text-[11px] text-paper-500">
                首次啟動需下載約 1.6 GB 語音模型，之後會直接讀取快取
              </p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function IconButton({
  label,
  onClick,
  highlightRing,
  children,
}: {
  label: string;
  onClick: () => void;
  highlightRing?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        className={`rounded-full p-1.5 text-paper-500 transition hover:bg-paper-200 hover:text-paper-900 ${
          highlightRing ? "ring-2 ring-recording/70 ring-offset-2 ring-offset-paper-50" : ""
        }`}
        onClick={onClick}
        aria-label={label}
      >
        {children}
      </button>
      <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-paper-900 px-2 py-0.5 text-[11px] font-medium text-paper-50 opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
        {label}
      </span>
    </span>
  );
}
