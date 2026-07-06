import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SessionMeta, StoredUtterance } from "@/lib/types";

type SummaryLang = "zh" | "en" | "vi";
const SUMMARY_LANGS: Array<{ id: SummaryLang; label: string }> = [
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
  { id: "vi", label: "Tiếng Việt" },
];

type SummaryTemplate =
  | "exec_brief"
  | "minutes"
  | "discussion"
  | "decision_log"
  | "client_call"
  | "slide_outline";
const SUMMARY_TEMPLATES: Array<{
  id: SummaryTemplate;
  label: string;
  description: string;
}> = [
  { id: "exec_brief", label: "AI 智能總結", description: "摘要 / 決議 / Actions / 待澄清" },
  { id: "minutes", label: "會議記錄", description: "正式紀錄 / 議程 / 行動方案" },
  { id: "discussion", label: "討論 / 腦力激盪", description: "主題觀點 / 共識 / 分歧" },
  { id: "decision_log", label: "決策推理", description: "候選方案 / 論點 / 結論" },
  { id: "client_call", label: "客戶 / 銷售會議", description: "需求 / Champion / BANT" },
  { id: "slide_outline", label: "簡報重點", description: "投影片大綱 / 餵給 AI 做簡報" },
];

type SummaryChunk = { session_id: string; target: SummaryLang; text: string };
type SummaryDone = { session_id: string; target: SummaryLang; path: string };
type SummaryError = { session_id: string; target: SummaryLang; message: string };
type SummaryRestart = { session_id: string; target: SummaryLang };

function formatStarted(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s === 0 ? `${m}min` : `${m}min ${s}s`;
}

function formatRelativeTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function HistoryModal({
  onClose,
  activeSessionId,
}: {
  onClose: () => void;
  /** ID of the session currently being recorded, if any. Used to disable
      the delete button on it (deleting a live session would corrupt the
      recorder's in-memory state — Rust also rejects this server-side). */
  activeSessionId: string | null;
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<SessionMeta | null>(null);
  const [utterances, setUtterances] = useState<StoredUtterance[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Summary state — keyed by lang, scoped to the currently selected session.
  // Reset whenever the user navigates to a different session.
  type ViewMode = "transcript" | SummaryLang;
  const [viewMode, setViewMode] = useState<ViewMode>("transcript");
  const [summaries, setSummaries] = useState<Record<SummaryLang, string | null>>(
    { zh: null, en: null, vi: null },
  );
  const [streamingTarget, setStreamingTarget] = useState<SummaryLang | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // Single template selection shared across the three lang tabs — most users
  // pick a style for the whole meeting, not per-lang.
  const [summaryTemplate, setSummaryTemplate] =
    useState<SummaryTemplate>("exec_brief");
  // Which lang is mid-confirmation for "重新產生 → 清除現有總結". Null
  // means no pending confirmation. Reset on tab switch and session change
  // so the user doesn't return to a stale "確定刪除？" prompt.
  const [pendingRegenerate, setPendingRegenerate] = useState<SummaryLang | null>(
    null,
  );
  // Keep a ref so streaming event handlers (set up once per modal mount) can
  // ignore events from sessions other than the one currently in detail view.
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const loadList = useCallback(async () => {
    try {
      const list = await invoke<SessionMeta[]>("list_sessions");
      setSessions(list);
    } catch (e) {
      setError(`load: ${e}`);
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const openSession = useCallback(async (meta: SessionMeta) => {
    setSelectedId(meta.session_id);
    setSelectedMeta(meta);
    setUtterances(null);
    setDetailLoading(true);
    setConfirmDelete(false);
    setSummaryError(null);
    setSummaries({ zh: null, en: null, vi: null });
    setViewMode("transcript");
    setPendingRegenerate(null);
    try {
      const trans = await invoke<StoredUtterance[]>("get_session_transcript", {
        sessionId: meta.session_id,
      });
      setUtterances(trans);
    } catch (e) {
      setError(`load transcript: ${e}`);
      setUtterances([]);
    } finally {
      setDetailLoading(false);
    }
    // Pre-load any existing summary files in parallel — we want them ready
    // when the user clicks a tab without making them wait for a re-fetch.
    for (const lang of SUMMARY_LANGS) {
      invoke<string | null>("read_summary", {
        sessionId: meta.session_id,
        target: lang.id,
      })
        .then((content) => {
          // Discard if user already navigated away.
          if (selectedIdRef.current !== meta.session_id) return;
          setSummaries((s) => ({ ...s, [lang.id]: content }));
        })
        .catch(() => {});
    }
  }, []);

  // Stream listeners — set up once per mount, dispatch by session_id+target.
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [
      listen<SummaryChunk>("summary:chunk", (e) => {
        if (e.payload.session_id !== selectedIdRef.current) return;
        setSummaries((s) => ({
          ...s,
          [e.payload.target]: (s[e.payload.target] ?? "") + e.payload.text,
        }));
      }),
      // Emitted when a mid-stream break triggers a full re-stream: drop the
      // partial we accumulated so the retry's chunks don't append onto it.
      listen<SummaryRestart>("summary:restart", (e) => {
        if (e.payload.session_id !== selectedIdRef.current) return;
        setSummaries((s) => ({ ...s, [e.payload.target]: "" }));
      }),
      listen<SummaryDone>("summary:done", (e) => {
        if (e.payload.session_id !== selectedIdRef.current) return;
        setStreamingTarget((t) => (t === e.payload.target ? null : t));
        // Refresh meta in the list view so the "已產生總結" tag appears.
        invoke<SessionMeta[]>("list_sessions")
          .then(setSessions)
          .catch(() => {});
        // Keep the local meta in sync so re-opening this session shows tags.
        setSelectedMeta((m) =>
          m && m.session_id === e.payload.session_id
            ? {
                ...m,
                has_summary_zh: e.payload.target === "zh" || m.has_summary_zh,
                has_summary_en: e.payload.target === "en" || m.has_summary_en,
                has_summary_vi: e.payload.target === "vi" || m.has_summary_vi,
              }
            : m,
        );
      }),
      listen<SummaryError>("summary:error", (e) => {
        if (e.payload.session_id !== selectedIdRef.current) return;
        setStreamingTarget((t) => (t === e.payload.target ? null : t));
        setSummaryError(e.payload.message);
      }),
    ];
    return () => {
      unlistens.forEach((p) => p.then((u) => u()).catch(() => {}));
    };
  }, []);

  const handleGenerateSummary = useCallback(
    async (target: SummaryLang) => {
      if (!selectedId || streamingTarget) return;
      setSummaryError(null);
      // Clear existing content so the user sees fresh streaming, not a
      // mash of old + new text.
      setSummaries((s) => ({ ...s, [target]: "" }));
      setStreamingTarget(target);
      setViewMode(target);
      try {
        await invoke("generate_summary", {
          sessionId: selectedId,
          target,
          template: summaryTemplate,
        });
      } catch (e) {
        // The Rust side also emits summary:error which clears streamingTarget,
        // so this only fires if invoke itself rejects (network refusal, etc).
        setSummaryError(String(e));
        setStreamingTarget(null);
      }
    },
    [selectedId, streamingTarget, summaryTemplate],
  );

  const switchView = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    setSummaryError(null);
    setPendingRegenerate(null);
  }, []);

  const handleConfirmRegenerate = useCallback((target: SummaryLang) => {
    // Clear in-memory content so SummaryPane drops back to the empty state
    // (template selector visible). The on-disk summary.{lang}.md stays
    // until the user actually generates a new one — at which point Rust
    // overwrites it. If the user backs out without regenerating, the old
    // file is still there and re-loads on next session open.
    setSummaries((s) => ({ ...s, [target]: null }));
    setPendingRegenerate(null);
    setSummaryError(null);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    try {
      await invoke("delete_session", { sessionId: selectedId });
      setSelectedId(null);
      setSelectedMeta(null);
      setUtterances(null);
      setConfirmDelete(false);
      await loadList();
    } catch (e) {
      setError(`delete: ${e}`);
    }
  }, [selectedId, loadList]);

  const handleOpenFolder = useCallback(async () => {
    if (!selectedId) return;
    try {
      await invoke("open_session_folder", { sessionId: selectedId });
    } catch (e) {
      setError(`open: ${e}`);
    }
  }, [selectedId]);

  const [exporting, setExporting] = useState(false);
  const handleExportTranscript = useCallback(async () => {
    if (!selectedId || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const path = await invoke<string>("export_session_markdown", {
        sessionId: selectedId,
      });
      invoke("reveal_in_finder", { path }).catch(() => {});
    } catch (e) {
      setError(`export: ${e}`);
    } finally {
      setExporting(false);
    }
  }, [selectedId, exporting]);

  const handleRevealSummary = useCallback(
    async (target: SummaryLang) => {
      if (!selectedId) return;
      try {
        await invoke("reveal_session_summary", {
          sessionId: selectedId,
          target,
        });
      } catch (e) {
        setError(`reveal: ${e}`);
      }
    },
    [selectedId],
  );

  const isActive = selectedId !== null && selectedId === activeSessionId;

  return (
    <div className="absolute inset-0 z-10 flex items-stretch justify-center bg-paper-900/30 p-4">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-lg border border-paper-200 bg-white shadow-xl">
        <header className="flex flex-shrink-0 items-center justify-between border-b border-paper-200 px-5 py-3">
          <div className="flex items-center gap-2">
            {selectedId && (
              <button
                className="text-paper-500 hover:text-paper-900"
                onClick={() => {
                  setSelectedId(null);
                  setSelectedMeta(null);
                  setUtterances(null);
                  setConfirmDelete(false);
                }}
                aria-label="返回列表"
              >
                ←
              </button>
            )}
            <h2 className="text-lg font-semibold">
              {selectedMeta ? formatStarted(selectedMeta.started_at) : "歷史會議"}
            </h2>
            {isActive && (
              <span className="rounded-full bg-recording/10 px-2 py-0.5 text-[10px] font-medium text-recording">
                錄音中
              </span>
            )}
          </div>
          <button
            className="text-paper-500 hover:text-paper-900"
            onClick={onClose}
            aria-label="關閉"
          >
            ✕
          </button>
        </header>

        {error && (
          <p className="mx-5 mt-2 rounded bg-danger-50 px-3 py-2 text-xs text-danger-700">
            {error}
          </p>
        )}

        {!selectedId ? (
          <div className="flex-1 overflow-y-auto">
            {sessions === null ? (
              <p className="px-5 py-6 text-sm text-paper-600">載入中…</p>
            ) : sessions.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-paper-500">
                <p className="text-sm">尚無會議記錄</p>
                <p className="text-center text-xs text-paper-400">
                  停止錄音後，這場會議會自動保存到這裡
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-paper-200">
                {sessions.map((s) => (
                  <li key={s.session_id}>
                    <button
                      className="w-full px-5 py-3 text-left transition hover:bg-paper-50"
                      onClick={() => openSession(s)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-paper-900">
                            {formatStarted(s.started_at)}
                          </p>
                          {s.session_id === activeSessionId && (
                            <span className="rounded-full bg-recording/10 px-1.5 py-0.5 text-[9px] font-medium text-recording">
                              錄音中
                            </span>
                          )}
                        </div>
                        <span className="text-paper-400">›</span>
                      </div>
                      <p className="mt-0.5 text-xs text-paper-600">
                        {formatDuration(s.duration_secs)} · {s.count} 句
                        {s.incomplete_count > 0 && (
                          <span className="text-warn-700">
                            {" "}（{s.incomplete_count} 句未完成翻譯）
                          </span>
                        )}
                      </p>
                      {(s.has_summary_zh || s.has_summary_en || s.has_summary_vi) && (
                        <p className="mt-0.5 text-[10px] uppercase tracking-wider text-paper-500">
                          已產生總結
                        </p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {selectedMeta && (
              <div className="flex-shrink-0 border-b border-paper-200 px-5 py-2 text-xs text-paper-600">
                {formatDuration(selectedMeta.duration_secs)} · {selectedMeta.count} 句 ·
                {" "}
                {selectedMeta.backend === "cloud" ? "雲端辨識" : "本地辨識"}
                {selectedMeta.device && ` · ${selectedMeta.device}`}
              </div>
            )}
            <nav className="flex flex-shrink-0 gap-1 border-b border-paper-200 px-3 py-1.5 text-xs">
              <TabButton
                active={viewMode === "transcript"}
                onClick={() => switchView("transcript")}
              >
                逐字稿
              </TabButton>
              {SUMMARY_LANGS.map((lang) => {
                const has =
                  summaries[lang.id] != null ||
                  (selectedMeta &&
                    ((lang.id === "zh" && selectedMeta.has_summary_zh) ||
                      (lang.id === "en" && selectedMeta.has_summary_en) ||
                      (lang.id === "vi" && selectedMeta.has_summary_vi)));
                return (
                  <TabButton
                    key={lang.id}
                    active={viewMode === lang.id}
                    onClick={() => switchView(lang.id)}
                  >
                    {lang.label}
                    {has && <span className="ml-1 text-paper-400">●</span>}
                    {streamingTarget === lang.id && (
                      <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-paper-700" />
                    )}
                  </TabButton>
                );
              })}
            </nav>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {viewMode === "transcript" ? (
                detailLoading ? (
                  <p className="text-sm text-paper-600">載入中…</p>
                ) : !utterances || utterances.length === 0 ? (
                  <p className="text-sm text-paper-500">這場會議沒有錄到內容。</p>
                ) : (
                  <>
                    <div className="mb-3 flex justify-end">
                      <button
                        className="rounded border border-paper-300 px-2.5 py-1 text-xs text-paper-700 hover:bg-paper-100 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={handleExportTranscript}
                        disabled={exporting}
                        type="button"
                        title="輸出逐字稿 transcript.md 並在 Finder 顯示"
                      >
                        {exporting ? "匯出中…" : "📝 匯出逐字稿"}
                      </button>
                    </div>
                    <ul className="space-y-3">
                      {utterances.map((u) => (
                        <li key={u.id} className="border-l-2 border-paper-200 pl-3">
                          <p className="font-mono text-[10px] uppercase tracking-wider text-paper-400">
                            {formatRelativeTime(u.t_start)}
                            {u.incomplete && (
                              <span className="ml-2 text-warn-700">未完成</span>
                            )}
                          </p>
                          <p className="mt-0.5 text-sm text-paper-900">{u.zh}</p>
                          {u.en && (
                            <p className="mt-0.5 text-xs text-paper-600">EN｜{u.en}</p>
                          )}
                          {u.vi && (
                            <p className="text-xs text-paper-600">VI｜{u.vi}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )
              ) : (
                <SummaryPane
                  content={summaries[viewMode]}
                  streaming={streamingTarget === viewMode}
                  error={summaryError}
                  template={summaryTemplate}
                  onTemplateChange={setSummaryTemplate}
                  onGenerate={() => handleGenerateSummary(viewMode)}
                  onReveal={() => handleRevealSummary(viewMode)}
                  hasOther={streamingTarget !== null && streamingTarget !== viewMode}
                  pendingConfirm={pendingRegenerate === viewMode}
                  onRequestRegenerate={() => setPendingRegenerate(viewMode)}
                  onCancelRegenerate={() => setPendingRegenerate(null)}
                  onConfirmRegenerate={() => handleConfirmRegenerate(viewMode)}
                />
              )}
            </div>
            <footer className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-t border-paper-200 px-5 py-3 text-xs">
              <button
                className="rounded border border-paper-300 px-2 py-1 text-paper-700 hover:bg-paper-100"
                onClick={handleOpenFolder}
                type="button"
                title="開啟整個會議資料夾"
              >
                📂 開啟資料夾
              </button>
              {confirmDelete ? (
                <span className="flex items-center gap-2">
                  <span className="text-paper-700">刪除整場會議？</span>
                  <button
                    className="rounded px-2 py-1 text-paper-600 hover:bg-paper-100"
                    onClick={() => setConfirmDelete(false)}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="rounded bg-danger-700 px-3 py-1 font-medium text-white hover:bg-danger-900"
                    onClick={handleDelete}
                    type="button"
                  >
                    確定刪除
                  </button>
                </span>
              ) : (
                <button
                  className="rounded border border-danger-200 px-2 py-1 text-danger-700 hover:bg-danger-50 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setConfirmDelete(true)}
                  disabled={isActive}
                  title={isActive ? "錄音中無法刪除" : ""}
                  type="button"
                >
                  🗑 刪除
                </button>
              )}
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rounded-md px-2.5 py-1 transition ${
        active
          ? "bg-paper-200 font-medium text-paper-900"
          : "text-paper-600 hover:bg-paper-100"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SummaryPane({
  content,
  streaming,
  error,
  template,
  onTemplateChange,
  onGenerate,
  onReveal,
  hasOther,
  pendingConfirm,
  onRequestRegenerate,
  onCancelRegenerate,
  onConfirmRegenerate,
}: {
  content: string | null;
  streaming: boolean;
  error: string | null;
  template: SummaryTemplate;
  onTemplateChange: (t: SummaryTemplate) => void;
  onGenerate: () => void;
  onReveal: () => void;
  hasOther: boolean;
  pendingConfirm: boolean;
  onRequestRegenerate: () => void;
  onCancelRegenerate: () => void;
  onConfirmRegenerate: () => void;
}) {
  const hasContent = content !== null && content.length > 0;
  const showTemplatePicker = !hasContent && !streaming;
  const selectorDisabled = hasOther;

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</p>
      )}

      {showTemplatePicker && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-paper-600">
            選擇總結模板
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {SUMMARY_TEMPLATES.map((t) => {
              const active = template === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTemplateChange(t.id)}
                  disabled={selectorDisabled}
                  className={`rounded-lg border px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? "border-paper-900 bg-paper-100"
                      : "border-paper-200 bg-white hover:border-paper-400 hover:bg-paper-50"
                  }`}
                >
                  <p
                    className={`truncate text-xs ${
                      active
                        ? "font-semibold text-paper-900"
                        : "font-medium text-paper-800"
                    }`}
                    title={t.label}
                  >
                    {t.label}
                  </p>
                  <p
                    className="mt-0.5 truncate text-[10px] text-paper-500"
                    title={t.description}
                  >
                    {t.description}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {showTemplatePicker ? (
        <div className="flex flex-col items-center gap-2 py-4 text-paper-500">
          <button
            type="button"
            className="rounded bg-paper-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-paper-700 disabled:cursor-not-allowed disabled:bg-paper-400"
            onClick={onGenerate}
            disabled={hasOther}
            title={hasOther ? "另一語言總結正在產生中" : ""}
          >
            產生總結
          </button>
          <p className="px-2 text-center text-[11px] text-paper-400">
            使用 Claude Sonnet 4.6，依逐字稿原文產出
          </p>
        </div>
      ) : (
        <>
          {!streaming && (
            pendingConfirm ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn-200 bg-warn-50 px-3 py-2 text-xs text-warn-900">
                <span>重新產生會清除目前的總結，再選新模板</span>
                <span className="flex gap-1.5">
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-paper-700 hover:bg-paper-100"
                    onClick={onCancelRegenerate}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="rounded bg-paper-900 px-3 py-1 font-medium text-white hover:bg-paper-700"
                    onClick={onConfirmRegenerate}
                  >
                    確定
                  </button>
                </span>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded border border-paper-300 px-2.5 py-1 text-xs text-paper-700 hover:bg-paper-100"
                  onClick={onReveal}
                  title="在 Finder 顯示這份總結 .md"
                >
                  📂 顯示檔案
                </button>
                <button
                  type="button"
                  className="rounded border border-paper-300 px-2.5 py-1 text-xs text-paper-700 hover:bg-paper-100 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={onRequestRegenerate}
                  disabled={hasOther}
                  title={hasOther ? "另一語言總結正在產生中" : ""}
                >
                  重新產生
                </button>
              </div>
            )
          )}
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-paper-900">
            {content ?? ""}
            {streaming && (
              <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-paper-700 align-middle" />
            )}
          </pre>
        </>
      )}
    </div>
  );
}
