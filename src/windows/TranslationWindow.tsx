import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emptyState, langInfo, nativeName } from "@/lib/languages";
import type { ChunkPayload, Config, TranscriptPayload } from "@/lib/types";

const FADE_WINDOW = 5;
const FONT_STEP = 4;
const FONT_MIN = 20;
const FONT_MAX = 64;

// One displayed line. The source (zh) text was never rendered here, so a slot
// only needs the target-language `text` for its own utterance id.
type Row = { id: string; text: string };

/** A translation window bound to a configurable slot. The label (t1/t2) fixes
 *  the slot; the language it renders is read from config at runtime and can be
 *  re-pointed live via `language:changed`. */
export default function TranslationWindow({ slotIndex }: { slotIndex: 0 | 1 }) {
  // null = still resolving, "" = slot disabled, otherwise an active lang code.
  const [lang, setLang] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [fontSize, setFontSize] = useState(32);
  const [pinned, setPinned] = useState(false);
  const [borderless, setBorderless] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const resolveLang = useCallback(async () => {
    try {
      const cfg = await invoke<Config>("get_config");
      const slot =
        cfg.language?.target_slots?.[slotIndex] ?? (slotIndex === 0 ? "en" : "vi");
      if (slot === "") {
        setLang(""); // slot explicitly disabled
      } else if (langInfo(slot)) {
        setLang(slot);
      } else {
        // A code we don't have in the registry — disable rather than subscribe
        // to a dead event name that would never deliver text.
        console.warn(`TranslationWindow slot ${slotIndex}: unknown language "${slot}"`);
        setLang("");
      }
    } catch {
      // Config unreadable (old build / dev) — fall back to the historical
      // per-slot default so the window still works.
      setLang(slotIndex === 0 ? "en" : "vi");
    }
  }, [slotIndex]);

  // Resolve on mount and whenever the language selection changes. The event is
  // only a "re-read config" signal; we don't trust its payload.
  useEffect(() => {
    resolveLang();
    const unlisten = listen("language:changed", () => resolveLang());
    return () => {
      unlisten.then((u) => u());
    };
  }, [resolveLang]);

  // React to the resolved language: clear stale content (wrong under a new
  // language) and retitle. Skipped while unresolved so the conf placeholder
  // title ("譯文視窗") shows during the brief load.
  useEffect(() => {
    if (lang === null) return;
    setRows([]);
    getCurrentWindow()
      .setTitle(lang ? nativeName(lang) : "MeetingCast")
      .catch(() => {});
  }, [lang]);

  // Translation event subscriptions — only for an active language code. null
  // (loading) and "" (disabled) have nothing to listen for.
  useEffect(() => {
    if (!lang) return;
    const unlistens: Array<Promise<() => void>> = [
      listen<TranscriptPayload>("transcript", (e) => {
        const { is_final, text, t_start } = e.payload;
        if (!is_final || !text) return;
        const id = String(t_start);
        setRows((prev) => {
          if (prev.some((u) => u.id === id)) return prev; // dedup
          return [...prev, { id, text: "" }];
        });
      }),
      listen<ChunkPayload>(`translation:chunk:${lang}`, (e) => {
        const { id, text } = e.payload;
        setRows((us) => {
          const idx = us.findIndex((u) => u.id === id);
          if (idx === -1) {
            // chunk arrived before the transcript event reached this window
            return [...us, { id, text }];
          }
          const updated: Row = { ...us[idx], text: us[idx].text + text };
          return [...us.slice(0, idx), updated, ...us.slice(idx + 1)];
        });
      }),
      // Non-streaming retry after a mid-stream break: REPLACE the displayed
      // text for this utterance rather than appending onto the partial.
      listen<ChunkPayload>(`translation:replace:${lang}`, (e) => {
        const { id, text } = e.payload;
        setRows((us) => {
          const idx = us.findIndex((u) => u.id === id);
          if (idx === -1) {
            return [...us, { id, text }];
          }
          const updated: Row = { ...us[idx], text };
          return [...us.slice(0, idx), updated, ...us.slice(idx + 1)];
        });
      }),
      listen("session:reset", () => {
        setRows([]);
      }),
    ];

    return () => {
      // Promise-based cleanup so StrictMode double-mounts (and language
      // re-points) don't leave duplicate listeners. If the promise hasn't
      // resolved yet, the unlisten still fires once it does.
      unlistens.forEach((p) => p.then((u) => u()));
    };
  }, [lang]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [rows]);

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

  const disabled = lang === "";

  return (
    <main className="flex h-screen flex-col bg-paper-100 text-paper-900">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-paper-300 px-6 py-1 text-xs font-medium uppercase tracking-wider text-paper-600">
        <span>{lang ? nativeName(lang) : "譯文視窗"}</span>
        {!disabled && (
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
        )}
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-10 py-6">
        {disabled ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-paper-500">
            <p style={{ fontSize: `${fontSize * 0.55}px` }} className="text-center">
              此視窗未啟用
            </p>
            <p
              style={{ fontSize: `${fontSize * 0.35}px` }}
              className="text-center text-paper-400"
            >
              可在「設定 → 語言」選擇第二個翻譯語言
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-paper-500">
            <p style={{ fontSize: `${fontSize * 0.55}px` }} className="text-center">
              {lang ? emptyState(lang).waiting : ""}
            </p>
            <p
              style={{ fontSize: `${fontSize * 0.35}px` }}
              className="text-center text-paper-400"
            >
              {lang ? emptyState(lang).hint : ""}
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {rows.map((u, idx) => {
              const distanceFromLast = rows.length - 1 - idx;
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
                  {u.text || <span className="text-paper-500">…</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
