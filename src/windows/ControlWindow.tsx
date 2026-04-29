import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SettingsModal from "@/components/SettingsModal";
import WelcomeWizard from "@/components/WelcomeWizard";
import { friendly } from "@/lib/errors";
import type { Config, Source, TranscriptPayload } from "@/lib/types";

const DEMO_WAV = "prototype/samples/weather_90s.wav";

type Toast = { kind: "info" | "warning" | "error"; message: string };

type CrashPayload = { attempt: number; max: number; stderr_tail?: string };
type RestoredPayload = { attempt: number };

export default function ControlWindow() {
  const [running, setRunning] = useState(false);
  const [backend, setBackend] = useState<"local" | "cloud">("local");
  const [useMic, setUseMic] = useState(false);
  const [latestZh, setLatestZh] = useState<string>("");
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [needsWelcome, setNeedsWelcome] = useState<Config | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const modelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);
  const backendRef = useRef(backend);
  const useMicRef = useRef(useMic);
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

  const handleStop = useCallback(async () => {
    try {
      await invoke("stop_stt");
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
      listen("stt:started", () => {
        setRunning(true);
        if (modelTimerRef.current) {
          clearTimeout(modelTimerRef.current);
          modelTimerRef.current = null;
        }
        setModelLoading(false);
      }),
      listen("stt:stopped", () => setRunning(false)),
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
          handleStart();
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
  }, [handleStart, handleStop, showToast]);

  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history]);

  return (
    <main className="relative flex h-screen flex-col bg-stone-50 text-stone-900">
      <header className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
        <div>
          <h1 className="text-xl font-semibold">MeetingCast</h1>
          <p className="text-xs text-stone-500">控制視窗</p>
        </div>
        <button
          className="rounded border border-stone-300 px-3 py-1 text-sm text-stone-600 hover:bg-stone-100"
          onClick={() => setShowSettings(true)}
        >
          設定
        </button>
      </header>

      <div className="flex flex-col gap-3 border-b border-stone-200 px-6 py-4">
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-stone-600">引擎</span>
            <select
              className="rounded border border-stone-300 bg-white px-2 py-1"
              value={backend}
              onChange={(e) => setBackend(e.target.value as "local" | "cloud")}
              disabled={running}
            >
              <option value="local">local (mlx)</option>
              <option value="cloud">cloud (deepgram)</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={useMic}
              onChange={(e) => setUseMic(e.target.checked)}
              disabled={running}
            />
            <span>麥克風（否則跑 weather demo）</span>
          </label>
        </div>
        <button
          className={`rounded px-6 py-3 text-base font-medium text-white transition ${
            running ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"
          }`}
          onClick={running ? handleStop : handleStart}
        >
          {running ? "停止" : "開始"}
        </button>
        <div className="rounded bg-stone-100 px-3 py-2 text-sm text-stone-600">
          狀態：{running ? "錄音中" : "閒置"}
        </div>
      </div>

      {error && (() => {
        const f = friendly(error);
        return (
          <div className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-sm text-rose-800">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <p className="font-medium">{f.primary}</p>
                {f.secondary && <p className="text-xs text-rose-700">{f.secondary}</p>}
              </div>
              <button
                className="text-xs text-rose-500 hover:text-rose-800"
                onClick={() => setError(null)}
                aria-label="關閉"
              >
                ✕
              </button>
            </div>
            {f.primary !== f.raw && (
              <details className="mt-1 text-xs text-rose-500">
                <summary className="cursor-pointer hover:text-rose-700">技術細節</summary>
                <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-rose-100 p-2 font-mono text-[10px]">
                  {f.raw}
                </pre>
              </details>
            )}
          </div>
        );
      })()}

      {toast && (
        <div
          className={`pointer-events-auto fixed right-4 top-4 z-20 max-w-xs rounded-md border px-4 py-2 text-sm shadow ${
            toast.kind === "error"
              ? "border-rose-300 bg-rose-50 text-rose-800"
              : toast.kind === "warning"
              ? "border-amber-300 bg-amber-50 text-amber-800"
              : "border-sky-300 bg-sky-50 text-sky-800"
          }`}
          onClick={() => setToast(null)}
        >
          {toast.message}
        </div>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {needsWelcome && (
        <WelcomeWizard
          initialConfig={needsWelcome}
          onDone={() => setNeedsWelcome(null)}
        />
      )}

      {modelLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-lg bg-white px-8 py-6 shadow-xl">
            <div className="flex items-center gap-3">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-stone-300 border-t-emerald-600" />
              <p className="font-medium text-stone-900">正在準備辨識模型</p>
            </div>
            <p className="max-w-xs text-center text-xs text-stone-500">
              首次啟動需下載 ~1.5 GB（mlx-whisper large-v3-turbo）。下次直接使用快取，這只是首次需要等。
            </p>
          </div>
        </div>
      )}

      <section className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-stone-200 px-6 py-1 text-xs font-medium uppercase tracking-wide text-stone-500">
          中文逐字稿
        </div>
        <div ref={historyRef} className="flex-1 overflow-y-auto px-6 py-3">
          {history.length === 0 && !latestZh ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-stone-500">
              <p className="text-base">按「開始」即可錄音翻譯</p>
              <p className="text-xs text-stone-400">
                也可用快捷鍵 <kbd className="rounded border border-stone-300 bg-stone-100 px-1.5 py-0.5 font-mono text-[11px]">⌘ Shift M</kbd> 切換
              </p>
            </div>
          ) : (
            <ul className="space-y-2 text-base leading-relaxed text-stone-800">
              {history.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
              {latestZh && <li className="text-stone-400 italic">{latestZh}</li>}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
