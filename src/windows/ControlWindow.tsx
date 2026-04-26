import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SettingsModal from "@/components/SettingsModal";
import type { Source, TranscriptPayload } from "@/lib/types";

const DEMO_WAV = "prototype/samples/weather_90s.wav";

export default function ControlWindow() {
  const [running, setRunning] = useState(false);
  const [backend, setBackend] = useState<"local" | "cloud">("local");
  const [useMic, setUseMic] = useState(false);
  const [latestZh, setLatestZh] = useState<string>("");
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlistenFns: Array<() => void> = [];

    listen<TranscriptPayload>("transcript", (e) => {
      const { text, is_final } = e.payload;
      if (!text) return;
      if (is_final) {
        setHistory((h) => [...h, text]);
        setLatestZh("");
        invoke("translate", { text, target: "en" }).catch((err) =>
          setError(`translate en: ${err}`),
        );
        invoke("translate", { text, target: "vi" }).catch((err) =>
          setError(`translate vi: ${err}`),
        );
      } else {
        setLatestZh(text);
      }
    }).then((u) => unlistenFns.push(u));

    listen("stt:started", () => setRunning(true)).then((u) => unlistenFns.push(u));
    listen("stt:stopped", () => setRunning(false)).then((u) => unlistenFns.push(u));
    listen<string>("stt:error", (e) => setError(e.payload)).then((u) =>
      unlistenFns.push(u),
    );

    return () => unlistenFns.forEach((f) => f());
  }, []);

  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history]);

  async function handleStart() {
    setError(null);
    setHistory([]);
    setLatestZh("");
    const source: Source = useMic ? { type: "mic" } : { type: "wav", path: DEMO_WAV };
    try {
      await invoke("start_stt", { backend, source });
    } catch (err) {
      setError(`start: ${err}`);
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_stt");
    } catch (err) {
      setError(`stop: ${err}`);
    }
  }

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

      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <section className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-stone-200 px-6 py-1 text-xs font-medium uppercase tracking-wide text-stone-500">
          中文逐字稿
        </div>
        <div ref={historyRef} className="flex-1 overflow-y-auto px-6 py-3">
          {history.length === 0 && !latestZh ? (
            <p className="text-sm text-stone-400">— 等待中 —</p>
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
