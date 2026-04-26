import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type Utterance = {
  id: string;
  zh: string;
  en: string;
  vi: string;
};

type TranscriptPayload = {
  type: "transcript";
  text: string;
  is_final: boolean;
  t_start: number;
  t_end: number;
};

type Source = { type: "mic" } | { type: "wav"; path: string };

const DEMO_WAV = "prototype/samples/weather_90s.wav";

function App() {
  const [running, setRunning] = useState(false);
  const [backend, setBackend] = useState<"local" | "cloud">("local");
  const [useMic, setUseMic] = useState(false); // default to WAV demo until mic permission lands
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const utteranceCounter = useRef(0);

  useEffect(() => {
    const unlistenFns: Array<() => void> = [];

    listen<TranscriptPayload>("transcript", (e) => {
      const { text, is_final } = e.payload;
      if (!is_final || !text) return;
      const id = String(utteranceCounter.current++);
      setUtterances((prev) => [...prev, { id, zh: text, en: "", vi: "" }]);
      // Fire parallel translations; chunks land via translation:chunk:* events
      invoke("translate", { text, target: "en" }).catch((err) =>
        setError(`translate en: ${err}`),
      );
      invoke("translate", { text, target: "vi" }).catch((err) =>
        setError(`translate vi: ${err}`),
      );
    }).then((u) => unlistenFns.push(u));

    listen<string>("translation:chunk:en", (e) => {
      setUtterances((us) => {
        if (us.length === 0) return us;
        const last = us[us.length - 1];
        return [...us.slice(0, -1), { ...last, en: last.en + e.payload }];
      });
    }).then((u) => unlistenFns.push(u));

    listen<string>("translation:chunk:vi", (e) => {
      setUtterances((us) => {
        if (us.length === 0) return us;
        const last = us[us.length - 1];
        return [...us.slice(0, -1), { ...last, vi: last.vi + e.payload }];
      });
    }).then((u) => unlistenFns.push(u));

    listen("stt:started", () => setRunning(true)).then((u) => unlistenFns.push(u));
    listen("stt:stopped", () => setRunning(false)).then((u) => unlistenFns.push(u));
    listen<string>("stt:error", (e) => setError(e.payload)).then((u) =>
      unlistenFns.push(u),
    );

    return () => unlistenFns.forEach((f) => f());
  }, []);

  async function handleStart() {
    setError(null);
    setUtterances([]);
    utteranceCounter.current = 0;
    const source: Source = useMic
      ? { type: "mic" }
      : { type: "wav", path: DEMO_WAV };
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
    <main className="flex h-screen flex-col bg-stone-50 text-stone-900">
      <header className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
        <div>
          <h1 className="text-xl font-semibold">MeetingCast</h1>
          <p className="text-xs text-stone-500">Phase 2 single-window demo</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <select
            className="rounded border border-stone-300 bg-white px-2 py-1"
            value={backend}
            onChange={(e) => setBackend(e.target.value as "local" | "cloud")}
            disabled={running}
          >
            <option value="local">local (mlx)</option>
            <option value="cloud">cloud (deepgram)</option>
          </select>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={useMic}
              onChange={(e) => setUseMic(e.target.checked)}
              disabled={running}
            />
            mic
          </label>
          <button
            className={`rounded px-4 py-1.5 font-medium text-white transition ${
              running ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"
            }`}
            onClick={running ? handleStop : handleStart}
          >
            {running ? "Stop" : "Start"}
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <section className="grid flex-1 grid-rows-3 gap-px overflow-hidden bg-stone-200">
        <Pane label="中文" lang="zh" utterances={utterances} />
        <Pane label="English" lang="en" utterances={utterances} />
        <Pane label="Tiếng Việt" lang="vi" utterances={utterances} />
      </section>
    </main>
  );
}

function Pane({
  label,
  lang,
  utterances,
}: {
  label: string;
  lang: "zh" | "en" | "vi";
  utterances: Utterance[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [utterances]);

  return (
    <div className="flex flex-col overflow-hidden bg-stone-50">
      <div className="flex-shrink-0 border-b border-stone-200 px-6 py-1 text-xs font-medium uppercase tracking-wide text-stone-500">
        {label}
      </div>
      <div ref={ref} className="flex-1 overflow-y-auto px-6 py-3">
        {utterances.length === 0 ? (
          <p className="text-sm text-stone-400">— 等待中 —</p>
        ) : (
          <ul className="space-y-2 text-base leading-relaxed">
            {utterances.map((u) => (
              <li key={u.id} className="text-stone-800">
                {u[lang] || <span className="text-stone-400">…</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default App;
