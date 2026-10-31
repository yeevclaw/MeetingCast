import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emptyState, langInfo, nativeName } from "@/lib/languages";
import type { ChunkPayload, Config, DonePayload, TranscriptPayload } from "@/lib/types";

const FADE_WINDOW = 5;
// Only the most recent rows are rendered (older ones sit at the 0.3 floor
// anyway; the full record lives in history). State keeps a little more so a
// late chunk for a just-scrolled-off row still finds its row.
const RENDER_CAP = 50;
const STATE_CAP = 200;
// A placeholder that never received a chunk is dropped after this long, in
// case its skip/error/done event got lost.
const PLACEHOLDER_TTL_MS = 20_000;
// "Stick to bottom" only when the reader is already this close to it.
const STICK_THRESHOLD_PX = 40;
// After the session stops, wait before dimming so the last lines stay readable.
const ENDED_DIM_DELAY_MS = 4_000;
const FONT_STEP = 4;
const FONT_MIN = 20;
const FONT_MAX = 64;
// Auto size: "最近三句可讀" — a 320px window lands near 29px, a 520px one near 47px.
const FONT_HEIGHT_DIVISOR = 11;

// One displayed line. The source text was never rendered here, so a slot only
// needs the target-language `text` for its own utterance id.
// `done` = no more text will arrive (translation finished, skipped or failed).
type Row = { id: string; text: string; done: boolean; createdAt: number };

type ErrorPayload = { id: string; message: string };

function newRow(id: string, text: string): Row {
  return { id, text, done: false, createdAt: Date.now() };
}

/** Immutably apply `fn` to the row with `id` (null = remove it). Rows that
 *  aren't found are created via `create` when given. Unchanged rows keep their
 *  identity so the memoized row components skip re-rendering. */
function patchRow(
  rows: Row[],
  id: string,
  fn: (r: Row) => Row | null,
  create?: () => Row,
): Row[] {
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) {
    if (!create) return rows;
    const next = [...rows, create()];
    return next.length > STATE_CAP ? next.slice(-STATE_CAP) : next;
  }
  const updated = fn(rows[idx]);
  if (updated === rows[idx]) return rows;
  if (updated === null) return [...rows.slice(0, idx), ...rows.slice(idx + 1)];
  return [...rows.slice(0, idx), updated, ...rows.slice(idx + 1)];
}

/** skip / error: an empty placeholder goes away; partial text stays, frozen. */
function settleRow(r: Row): Row | null {
  if (!r.text) return null;
  return r.done ? r : { ...r, done: true };
}

const RowItem = memo(function RowItem({
  text,
  opacity,
  fontSize,
}: {
  text: string;
  opacity: number;
  fontSize: number;
}) {
  return (
    <li
      className="font-medium leading-snug transition-opacity duration-500"
      style={{ opacity, fontSize: `${fontSize}px` }}
    >
      {text || <span className="text-stage-dim">…</span>}
    </li>
  );
});

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
  // `ended` lagged by ENDED_DIM_DELAY_MS — drives the post-session dim.
  const [endedDim, setEndedDim] = useState(false);
  const [online, setOnline] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the reader is at (or near) the bottom. Updated on user scroll only;
  // content growth doesn't fire scroll events, so it reflects their intent.
  const stickRef = useRef(true);

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
        // patchRow's identity fn = dedup when the row already exists.
        setRows((prev) => patchRow(prev, id, (r) => r, () => newRow(id, "")));
      }),
      listen<ChunkPayload>(`translation:chunk:${lang}`, (e) => {
        const { id, text } = e.payload;
        if (!text) return;
        // A missing row = chunk arrived before the transcript event did.
        setRows((us) =>
          patchRow(us, id, (r) => ({ ...r, text: r.text + text }), () => newRow(id, text)),
        );
      }),
      // Non-streaming retry after a mid-stream break: REPLACE the displayed
      // text for this utterance rather than appending onto the partial.
      listen<ChunkPayload>(`translation:replace:${lang}`, (e) => {
        const { id, text } = e.payload;
        setRows((us) => patchRow(us, id, (r) => ({ ...r, text }), () => newRow(id, text)));
      }),
      listen<DonePayload>(`translation:done:${lang}`, (e) => {
        // Done with no text is effectively a skip.
        setRows((us) => patchRow(us, e.payload.id, settleRow));
      }),
      // This row will never be translated (too short / offline / failed).
      listen<DonePayload>(`translation:skip:${lang}`, (e) => {
        setRows((us) => patchRow(us, e.payload.id, settleRow));
      }),
      // Errors surface in the control window; the projector only settles the row.
      listen<ErrorPayload>(`translation:error:${lang}`, (e) => {
        setRows((us) => patchRow(us, e.payload.id, settleRow));
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

  // Safety net: drop placeholders that never got a single chunk.
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      setRows((us) => {
        const keep = us.filter((r) => r.text || now - r.createdAt < PLACEHOLDER_TTL_MS);
        return keep.length === us.length ? us : keep;
      });
    }, 5_000);
    return () => window.clearInterval(t);
  }, []);

  // Delay the post-session dim; un-dim immediately when a new session starts.
  useEffect(() => {
    if (!ended) {
      setEndedDim(false);
      return;
    }
    const t = window.setTimeout(() => setEndedDim(true), ENDED_DIM_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [ended]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }

  // Auto font size follows the window height; A− / A+ is a persisted offset.
  useEffect(() => {
    const onResize = () => setBaseFont(baseFontSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Fullscreen can be left via the green button / ⌃⌘F without our toggle;
  // re-read the real state on every resize so the button doesn't desync.
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => {
      w.isFullscreen()
        .then(setFullscreen)
        .catch(() => {});
    };
    sync();
    const un = w.onResized(sync);
    return () => {
      un.then((u) => u());
    };
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

  // Follow new text only when the reader is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rows, fontSize]);

  const visible = rows.length > RENDER_CAP ? rows.slice(-RENDER_CAP) : rows;
  // Fade distance counts only rows with text, so trailing placeholders can't
  // push real translations into the faded zone. A placeholder takes the
  // distance of the text row that would follow it.
  const distances: number[] = new Array(visible.length);
  {
    let textAfter = 0;
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].text) {
        distances[i] = textAfter;
        textAfter++;
      } else {
        distances[i] = Math.max(0, textAfter - 1);
      }
    }
  }

  const btn = (active: boolean) =>
    `rounded px-2 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stage-fg transition-colors hover:bg-stage-rule hover:text-stage-fg ${
      active ? "bg-stage-rule text-stage-fg" : ""
    }`;

  return (
    <main
      className={`aura-host group flex h-screen flex-col bg-stage-bg text-stage-fg ${
        lightTheme ? "stage-light" : ""
      }`}
      data-aura={auraOff ? "off" : undefined}
      data-live={live ? "true" : undefined}
      data-paused={paused ? "true" : undefined}
    >
      {/* Drag handle: Tauri only honours data-tauri-drag-region on the element
          itself, so the non-interactive children carry it too. */}
      <header
        data-tauri-drag-region
        className="flex flex-shrink-0 items-center justify-between border-b border-stage-rule bg-stage-chrome px-4 py-1.5 text-xs text-stage-dim"
      >
        <span data-tauri-drag-region className="flex items-center gap-2">
          <b
            data-tauri-drag-region
            className="text-[13px] font-semibold tracking-wide text-stage-fg"
          >
            {lang ? nativeName(lang) : "譯文視窗"}
          </b>
          {ended && !disabled && (
            <span data-tauri-drag-region className="text-[11px]">
              已結束
            </span>
          )}
        </span>
        {!disabled && (
          // Borderless = projector mode: controls only appear while hovering.
          <div
            className={`flex items-center gap-1 transition-opacity duration-300 ${
              borderless ? "opacity-0 group-hover:opacity-100 focus-within:opacity-100" : ""
            }`}
          >
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

      <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto px-10 py-6">
        {disabled ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-stage-dim">
            <p style={{ fontSize: `${fontSize * 0.55}px` }} className="text-center">
              此視窗未啟用
            </p>
            <p style={{ fontSize: `max(14px, ${fontSize * 0.35}px)` }} className="text-center">
              可在主控台右欄「本場設定」選擇第二個翻譯語言
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-stage-dim">
            <p style={{ fontSize: `${fontSize * 0.55}px` }} className="text-center">
              {lang ? emptyState(lang).waiting : ""}
            </p>
            <p style={{ fontSize: `max(14px, ${fontSize * 0.35}px)` }} className="text-center">
              {lang ? emptyState(lang).hint : ""}
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {visible.map((u, idx) => {
              const distanceFromLast = distances[idx];
              // Last FADE_WINDOW text rows get a fresh→dim gradient; older
              // items stay at the 0.3 floor (still readable, scrollable). A
              // few seconds after the session ends the column dims by half —
              // except the newest row while it is still streaming.
              const base =
                distanceFromLast >= FADE_WINDOW
                  ? 0.3
                  : Math.max(0.3, 1 - distanceFromLast * 0.18);
              const streamingLast = idx === visible.length - 1 && !u.done;
              const opacity = endedDim && !streamingLast ? base * 0.5 : base;
              return <RowItem key={u.id} text={u.text} opacity={opacity} fontSize={fontSize} />;
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
