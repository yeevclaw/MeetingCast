import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import MicMeter from "@/components/MicMeter";
import SettingsModal from "@/components/SettingsModal";
import WelcomeWizard from "@/components/WelcomeWizard";
import { friendly } from "@/lib/errors";
import type { Config, Source, TranscriptPayload } from "@/lib/types";

const DEMO_WAV = "prototype/samples/weather_90s.wav";

type Toast = { kind: "info" | "warning" | "error"; message: string };

type CrashPayload = { attempt: number; max: number; stderr_tail?: string };
type RestoredPayload = { attempt: number };
type PrewarmPayload = { step: string; state: "start" | "done" | "error"; message?: string | null };

type StepStatus = "pending" | "in_progress" | "done" | "error";
type StepId = "spawn" | "model" | "mic";

// "就緒" is intentionally not a row — when the ready event fires, the
// overlay dismisses and the user moves on, so a row that never visibly
// ticks would just look stuck. Three concrete steps is clearer.
const PREWARM_STEPS: Array<{ id: StepId; label: string }> = [
  { id: "spawn", label: "啟動辨識子程序" },
  { id: "model", label: "載入語音模型" },
  { id: "mic", label: "初始化麥克風" },
];

function SettingsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
  const [backend, setBackend] = useState<"local" | "cloud">("local");
  const [useMic, setUseMic] = useState(true);
  const [micAvailable, setMicAvailable] = useState<boolean | null>(null);
  const [latestZh, setLatestZh] = useState<string>("");
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
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
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const modelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);
  const backendRef = useRef(backend);
  const useMicRef = useRef(useMic);
  const hasHistoryRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // First-run detection: show wizard until anthropic key is set.
    invoke<Config>("get_config")
      .then((cfg) => {
        if (!cfg.api.anthropic_api_key.trim()) {
          setNeedsWelcome(cfg);
        }
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
  }, []);

  useEffect(() => {
    // Acquire microphone permission AT APP LAUNCH instead of on the user's
    // first 開始錄音 click. getUserMedia triggers macOS's privacy prompt
    // for the .app bundle; once granted, the sidecar subprocess inherits
    // permission and opens its own InputStream without re-prompting. We
    // immediately stop the tracks because we only needed the permission,
    // not the audio data.
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

  const handleStart = useCallback(async () => {
    setError(null);
    setHistory([]);
    setLatestZh("");
    const source: Source = useMicRef.current
      ? { type: "mic" }
      : { type: "wav", path: DEMO_WAV };
    try {
      await invoke("start_stt", { backend: backendRef.current, source });
    } catch (err) {
      setError(`start: ${err}`);
    }
  }, []);

  const requestStart = useCallback(() => {
    if (hasHistoryRef.current) {
      setConfirmRestart(true);
    } else {
      handleStart();
    }
  }, [handleStart]);

  const handleStop = useCallback(async () => {
    try {
      await invoke("stop_stt");
      // Drop rolling translation context so a new session doesn't carry
      // pronouns / topic from the previous meeting into its first sentence.
      invoke("clear_translation_context").catch(() => {});
    } catch (err) {
      setError(`stop: ${err}`);
    }
  }, []);

  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [
      listen<TranscriptPayload>("transcript", (e) => {
        const { text, is_final, t_start } = e.payload;
        if (!text) return;
        if (is_final) {
          setHistory((h) => [...h, text]);
          setLatestZh("");
          const id = String(t_start);
          invoke("translate", { id, text, target: "en" }).catch((err) =>
            setError(`translate en: ${err}`),
          );
          invoke("translate", { id, text, target: "vi" }).catch((err) =>
            setError(`translate vi: ${err}`),
          );
        } else {
          setLatestZh(text);
        }
      }),
      listen("stt:ready", () => {
        setSidecarReady(true);
        // Whatever individual step events we missed — flip everything to
        // done since the sidecar declared global readiness.
        setStepStatus({ spawn: "done", model: "done", mic: "done" });
      }),
      listen<PrewarmPayload>("stt:prewarm", (e) => {
        const { step, state, message } = e.payload;
        const id = step as StepId;
        // First sidecar event of any kind also confirms the spawn step. The
        // child has reached our Python entry; the bootstrapper is past.
        setStepStatus((s) => {
          const next: Record<StepId, StepStatus> = { ...s };
          if (next.spawn !== "done") next.spawn = "done";
          next[id] =
            state === "start" ? "in_progress" : state === "done" ? "done" : "error";
          return next;
        });
        if (state === "error" && message) {
          setStepError((m) => ({ ...m, [id]: message }));
        }
      }),
      listen("stt:started", () => {
        setRunning(true);
        setSessionStartedAt(Date.now());
        if (modelTimerRef.current) {
          clearTimeout(modelTimerRef.current);
          modelTimerRef.current = null;
        }
        setModelLoading(false);
      }),
      listen("stt:stopped", () => {
        setRunning(false);
        setSessionStartedAt(null);
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
  }, [handleStop, requestStart, showToast]);

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

  return (
    <main className="relative flex h-screen flex-col bg-paper-50 text-paper-900">

      {micMissing && (
        <div className="mx-4 mb-3 rounded-2xl border border-warn-200 bg-warn-50 px-4 py-3 text-sm">
          <p className="font-medium text-warn-900">未偵測到麥克風</p>
          <p className="mt-0.5 text-xs text-warn-700">
            請確認麥克風已接好、系統設定有授權；或暫時取消下方麥克風選項改用 demo 檔測試
          </p>
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
          <MicMeter active={running && useMic} />
        </span>
        <span className="flex items-center gap-3">
          <span
            className={`font-mono tabular-nums ${
              running ? "text-paper-900" : "text-paper-400"
            }`}
          >
            {running ? formatElapsed(elapsed) : "0:00"}
          </span>
          <button
            className="rounded-full p-1.5 text-paper-500 transition hover:bg-paper-200 hover:text-paper-900"
            onClick={() => setShowSettings(true)}
            aria-label="設定"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </span>
      </div>

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
          中文逐字稿
        </div>
        <div ref={historyRef} className="flex-1 overflow-y-auto px-5 py-4">
          {history.length === 0 && !latestZh ? (
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
          ) : (
            <ul className="space-y-2 text-base leading-relaxed text-paper-900">
              {history.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
              {latestZh && <li className="italic text-paper-500">{latestZh}</li>}
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
          onClose={() => setShowSettings(false)}
          backend={backend}
          setBackend={setBackend}
          useMic={useMic}
          setUseMic={setUseMic}
          running={running}
        />
      )}

      {needsWelcome && (
        <WelcomeWizard
          initialConfig={needsWelcome}
          onDone={() => setNeedsWelcome(null)}
        />
      )}

      {confirmRestart && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-paper-900/30 p-4">
          <div className="w-full max-w-sm rounded-lg border border-paper-200 bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-paper-900">開始新的錄音？</h2>
            <p className="mt-2 text-sm text-paper-600">
              繼續會清除目前的中文逐字稿與英文／越南文譯文。
            </p>
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
              首次啟動需下載 ~1.5 GB（mlx-whisper large-v3-turbo）。下次直接使用快取，這只是首次需要等。
            </p>
          </div>
        </div>
      )}

      {sidecarReady !== true && !modelLoading && !needsWelcome && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper-900/30 backdrop-blur-sm">
          <div className="w-[300px] rounded-2xl border border-paper-200 bg-white px-6 py-5 shadow-xl">
            <p className="mb-4 text-center font-medium text-paper-900">正在啟動辨識引擎</p>
            <ul className="space-y-2.5">
              {PREWARM_STEPS.map((s) => {
                const status = stepStatus[s.id];
                const err = stepError[s.id];
                return (
                  <li key={s.id} className="flex items-start gap-3 text-sm">
                    <StepIcon status={status} />
                    <div className="flex-1">
                      <p
                        className={
                          status === "done"
                            ? "text-paper-500 line-through decoration-paper-400"
                            : status === "in_progress"
                              ? "font-medium text-paper-900"
                              : status === "error"
                                ? "font-medium text-danger-700"
                                : "text-paper-500"
                        }
                      >
                        {s.label}
                      </p>
                      {err && status === "error" && (
                        <p className="mt-0.5 break-all text-[11px] text-danger-700">{err}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-4 text-center text-[11px] text-paper-500">
              首次啟動需下載 ~1.5 GB 語音模型，之後會直接讀取快取
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") {
    return (
      <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-paper-700 text-white">
        <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5 L6.5 12 L13 4.5" />
        </svg>
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="mt-0.5 inline-block h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-paper-200 border-t-paper-900" />
    );
  }
  if (status === "error") {
    return (
      <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-danger-700 text-[10px] font-bold text-white">
        ×
      </span>
    );
  }
  return (
    <span className="mt-0.5 inline-block h-4 w-4 flex-shrink-0 rounded-full border-2 border-paper-300" />
  );
}
