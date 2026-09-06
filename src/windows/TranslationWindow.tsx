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
// Auto size: "最近三句可讀" — a 320px window lands near 29px, a 520px one near 47px.
const FONT_HEIGHT_DIVISOR = 11;

// One displayed line. The source text was never rendered here, so a slot only
// needs the target-language `text` for its own utterance id.
type Row = { id: string; text: string };

type NetworkPayload = { online: boolean };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function baseFontSize(): number {
  return clamp(Math.round(window.innerHeight / FONT_HEIGHT_DIVISOR), FONT_MIN, FONT_MAX);
}

function offsetKey(): string {
  return `mc_font_offset_${getCurrentWindow().label}`;
}

function readOffset(): number {
  try {
    const v = parseInt(localStorage.getItem(offsetKey()) ?? "0", 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeOffset(v: number) {
  try {
    localStorage.setItem(offsetKey(), String(v));
  } catch {
    // Storage unavailable — the offset simply doesn't persist.
  }
}

/** A translation window bound to a configurable slot. The label (t1/t2) fixes
 *  the slot; the language it renders is read from config at runtime and can be
 *  re-pointed live via `language:changed`. Appearance (theme / glow) is global
 *  and re-read on `config:changed`. */
export default function TranslationWindow({ slotIndex }: { slotIndex: 0 | 1 }) {
  // null = still resolving, "" = slot disabled, otherwise an active lang code.
  const [lang, setLang] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [baseFont, setBaseFont] = useState(baseFontSize);
  const [fontOffset, setFontOffset] = useState(readOffset);
  const [pinned, setPinned] = useState(false);
  const [borderless, setBorderless] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Global appearance from config `[ui]`.
  const [lightTheme, setLightTheme] = useState(false);
  const [glow, setGlow] = useState(true);
  // Session state driving the aura + banners.
  const [live, setLive] = useState(false);
  const [ended, setEnded] = useState(false);
  const [online, setOnline] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Read language + appearance from config. Called on mount and whenever Rust
  // signals a change; the event payloads are never trusted, only get_config.
  const loadConfig = useCallback(async () => {
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
      setLightTheme(cfg.ui?.translation_theme === "light");
      setGlow(cfg.ui?.glow !== false);
    } catch {
      // Config unreadable (old build / dev) — fall back to the historical
      // per-slot default so the window still works.
      setLang(slotIndex === 0 ? "en" : "vi");
    }
  }, [slotIndex]);

  useEffect(() => {
    loadConfig();
    const unlistens = [
      listen("language:changed", () => loadConfig()),
      listen("config:changed", () => loadConfig()),
    ];
    return () => {
      unlistens.forEach((p) => p.then((u) => u()));
    };
  }, [loadConfig]);

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

  // Session + network state — independent of the language, so subscribed once.
  useEffect(() => {
    invoke<boolean>("network_status")
      .then(setOnline)
      .catch(() => {});
    const unlistens: Array<Promise<() => void>> = [
      listen("stt:started", () => {
        setLive(true);
        setEnded(false);
      }),
      listen("stt:stopped", () => {
        setLive(false);
        setEnded(true);
      }),
      listen("session:reset", () => {
        setEnded(false);
      }),
      listen<NetworkPayload>("network:status", (e) => {
        setOnline(e.payload.online);
      }),
    ];
    return () => {
      unlistens.forEach((p) => p.then((u) => u()));
    };
  }, []);

  // Translation event subscriptions — only for an active language code. null
  // (loading) and "" (disabled) have nothing to listen for.
  useEffect(() => {
    if (!lang) return;
    const unlistens: Array<Promise<() => void>> = [
      listen<TranscriptPayload>("transcript", (e) => {
        const { is_final, text, t_start, utterance_id } = e.payload;
        if (!is_final || !text) return;
        // Incremental mode groups several segments under one utterance id;
        // sentence mode keys by t_start. Either way one row per utterance.
        const id = utterance_id ?? String(t_start);
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

  // Auto font size follows the window height; A− / A+ is a persisted offset.
  useEffect(() => {
    const onResize = () => setBaseFont(baseFontSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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

  async function toggleFullscreen() {
    const w = getCurrentWindow();
    const next = !fullscreen;
    await w.setFullscreen(next);
    setFullscreen(next);
  }

  function bumpFont(delta: number) {
    setFontOffset((o) => {
      // Keep the effective size inside [FONT_MIN, FONT_MAX] for the current
      // window height; the stored offset is whatever gets us there.
      const next = clamp(baseFont + o + delta, FONT_MIN, FONT_MAX) - baseFont;
      writeOffset(next);
      return next;
    });
  }

  const fontSize = clamp(baseFont + fontOffset, FONT_MIN, FONT_MAX);
  const disabled = lang === "";
  const paused = live && !online && !disabled;
  // Borderless is the "projector only shows words" mode — drop the aura too.
  const auraOff = !glow || borderless;

  const btn = (active: boolean) =>
    `rounded px-2 py-0.5 transition-colors hover:bg-stage-rule hover:text-stage-fg ${
      active ? "bg-stage-rule text-stage-fg" : ""
    }`;

  return (
    <main
      className={`aura-host flex h-screen flex-col bg-stage-bg text-stage-fg ${
        lightTheme ? "stage-light" : ""
      }`}
      data-aura={auraOff ? "off" : undefined}
      data-live={live ? "true" : undefined}
      data-paused={paused ? "true" : undefined}
    >
      <header className="flex flex-shrink-0 items-center justify-between border-b border-stage-rule bg-stage-chrome px-4 py-1.5 text-xs text-stage-dim">
        <span className="flex items-center gap-2">
          <b className="text-[13px] font-semibold tracking-wide text-stage-fg">
            {lang ? nativeName(lang) : "譯文視窗"}
          </b>
          {ended && !disabled && <span className="text-[11px]">已結束</span>}
        </span>
        {!disabled && (
          <div className="flex items-center gap-1">
            <button className={btn(false)} onClick={() => bumpFont(-FONT_STEP)} aria-label="字小">
              A−
            </button>
            <button className={btn(false)} onClick={() => bumpFont(FONT_STEP)} aria-label="字大">
              A+
            </button>
            <button
              className={btn(pinned)}
              onClick={togglePin}
              aria-pressed={pinned}
              title="釘到最前面"
            >
              釘選
            </button>
            <button
              className={btn(borderless)}
              onClick={toggleBorderless}
              aria-pressed={borderless}
              title="隱藏視窗邊框與光暈"
            >
              無邊框
            </button>
            <button
              className={btn(fullscreen)}
              onClick={toggleFullscreen}
              aria-pressed={fullscreen}
              title="全螢幕"
            >
              全螢幕
            </button>
          </div>
        )}
      </header>

      <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-10 py-6">
        {disabled ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-stage-dim">
            <p style={{ fontSize: `${fontSize * 0.55}px` }} className="text-center">
              此視窗未啟用
            </p>
            <p style={{ fontSize: `${fontSize * 0.35}px` }} className="text-center opacity-70">
              可在「設定 → 會議」選擇第二個翻譯語言
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-stage-dim">
            <p style={{ fontSize: `${fontSize * 0.55}px` }} className="text-center">
              {lang ? emptyState(lang).waiting : ""}
            </p>
            <p style={{ fontSize: `${fontSize * 0.35}px` }} className="text-center opacity-70">
              {lang ? emptyState(lang).hint : ""}
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {rows.map((u, idx) => {
              const distanceFromLast = rows.length - 1 - idx;
              // Last FADE_WINDOW items get a fresh→dim gradient; older items
              // stay at the 0.3 floor (still readable, scrollable). After the
              // session ends the whole column dims by half.
              const base =
                distanceFromLast >= FADE_WINDOW
                  ? 0.3
                  : Math.max(0.3, 1 - distanceFromLast * 0.18);
              const opacity = ended ? base * 0.5 : base;
              return (
                <li
                  key={u.id}
                  className="font-medium leading-snug transition-opacity duration-500"
                  style={{ opacity, fontSize: `${fontSize}px` }}
                >
                  {u.text || <span className="text-stage-dim">…</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {paused && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[2] flex justify-center">
          <span
            className={`rounded-full border px-4 py-1.5 text-xs backdrop-blur-sm ${
              lightTheme
                ? "border-warn-200 bg-warn-50 text-warn-900"
                : "border-warn-700/40 bg-warn-700/20 text-warn-200"
            }`}
          >
            翻譯暫停，網路恢復後自動繼續
          </span>
        </div>
      )}
    </main>
  );
}
