import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ChunkPayload, Lang, TranscriptPayload, Utterance } from "@/lib/types";

const TITLES: Record<Lang, string> = {
  en: "English",
  vi: "Tiếng Việt",
};

const FADE_WINDOW = 5;
const FONT_STEP = 4;
const FONT_MIN = 20;
const FONT_MAX = 64;

export default function TranslationWindow({ lang }: { lang: Lang }) {
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [fontSize, setFontSize] = useState(32);
  const [pinned, setPinned] = useState(false);
  const [borderless, setBorderless] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [
      listen<TranscriptPayload>("transcript", (e) => {
        const { is_final, text, t_start } = e.payload;
        if (!is_final || !text) return;
        const id = String(t_start);
        setUtterances((prev) => {
          if (prev.some((u) => u.id === id)) return prev; // dedup
          return [...prev, { id, zh: text, en: "", vi: "" }];
        });
      }),
      listen<ChunkPayload>(`translation:chunk:${lang}`, (e) => {
        const { id, text } = e.payload;
        setUtterances((us) => {
          const idx = us.findIndex((u) => u.id === id);
          if (idx === -1) {
            // chunk arrived before transcript event reached this window — buffer as new
            return [...us, { id, zh: "", en: "", vi: "", [lang]: text }] as Utterance[];
          }
          const updated: Utterance = { ...us[idx], [lang]: us[idx][lang] + text };
          return [...us.slice(0, idx), updated, ...us.slice(idx + 1)];
        });
      }),
      listen("session:reset", () => {
        setUtterances([]);
      }),
    ];

    return () => {
      // Promise-based cleanup so StrictMode double-mounts don't leave duplicate
      // listeners. If the promise hasn't resolved yet, the unlisten still fires
      // once it does.
      unlistens.forEach((p) => p.then((u) => u()));
    };
  }, [lang]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [utterances]);

  async function togglePin() {
    const w = getCurrentWindow();
    const next = !pinned;
    await w.setAlwaysOnTop(next);
    setPinned(next);
  }

  async function toggleBorderless() {
    const w = getCurrentWindow();
    const next = !borderless;
    await w.setDecorations(!next);
    setBorderless(next);
  }

  function bumpFont(delta: number) {
    setFontSize((s) => Math.max(FONT_MIN, Math.min(FONT_MAX, s + delta)));
  }

  return (
    <main className="flex h-screen flex-col bg-paper-100 text-paper-900">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-paper-300 px-6 py-1 text-xs font-medium uppercase tracking-wider text-paper-600">
        <span>{TITLES[lang]}</span>
        <div className="flex items-center gap-1 normal-case tracking-normal">
          <button
            className="rounded px-2 py-0.5 hover:bg-paper-300"
            onClick={() => bumpFont(-FONT_STEP)}
            aria-label="字小"
          >
            A−
          </button>
          <span className="w-8 text-center tabular-nums">{fontSize}</span>
          <button
            className="rounded px-2 py-0.5 hover:bg-paper-300"
            onClick={() => bumpFont(FONT_STEP)}
            aria-label="字大"
          >
            A+
          </button>
          <button
            className={`rounded px-2 py-0.5 hover:bg-paper-300 ${pinned ? "bg-paper-300 text-paper-900" : ""}`}
            onClick={togglePin}
            aria-label="釘選"
            title="釘到最前面"
          >
            {pinned ? "📌" : "📍"}
          </button>
          <button
            className={`rounded px-2 py-0.5 hover:bg-paper-300 ${borderless ? "bg-paper-300 text-paper-900" : ""}`}
            onClick={toggleBorderless}
            aria-label="無邊框"
            title="無邊框"
          >
            ⬚
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-10 py-6">
        {utterances.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-paper-500">
            <p style={{ fontSize: `${fontSize * 0.55}px` }} className="text-center">
              {lang === "en" ? "Translation will appear here once recording starts" : "Bản dịch sẽ hiện ở đây khi bắt đầu ghi âm"}
            </p>
            <p style={{ fontSize: `${fontSize * 0.35}px` }} className="text-center text-paper-400">
              {lang === "en" ? "Press Start in the control window" : "Bấm Bắt đầu ở cửa sổ điều khiển"}
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {utterances.map((u, idx) => {
              const distanceFromLast = utterances.length - 1 - idx;
              // Last FADE_WINDOW items get a fresh→dim gradient; older
              // items stay at the 0.3 floor (still readable, scrollable).
              const opacity =
                distanceFromLast >= FADE_WINDOW
                  ? 0.3
                  : Math.max(0.3, 1 - distanceFromLast * 0.18);
              return (
                <li
                  key={u.id}
                  className="leading-snug"
                  style={{ opacity, fontSize: `${fontSize}px` }}
                >
                  {u[lang] || <span className="text-paper-500">…</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
