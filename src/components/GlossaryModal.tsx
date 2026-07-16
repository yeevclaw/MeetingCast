import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Config, GlossaryBook, GlossaryEntry } from "@/lib/types";
import { LANGS, selectLabel, zhName } from "@/lib/languages";

const EXAMPLE_ENTRY: GlossaryEntry = {
  term: "紫微斗數",
  aliases: ["紫薇斗數", "子位斗數"],
  translations: { en: "Zi Wei Dou Shu", vi: "Tử Vi Đẩu Số", ja: "紫微斗数" },
};

// Editable form for one entry. `aliasesText` is the comma-joined view (split to
// string[] at save time); `translations` maps a registry language code to that
// term's translation.
type RowForm = {
  rowId: string;
  term: string;
  aliasesText: string;
  translations: Record<string, string>;
};

function entryToRow(entry: GlossaryEntry, idx: number): RowForm {
  // Fold the legacy en/vi mirror fields into the map so a pre-v2 entry (map
  // empty, mirrors set) still surfaces its translations.
  const translations: Record<string, string> = { ...entry.translations };
  if (entry.en && translations.en === undefined) translations.en = entry.en;
  if (entry.vi && translations.vi === undefined) translations.vi = entry.vi;
  return {
    rowId: `r${idx}-${entry.term}`,
    term: entry.term,
    aliasesText: (entry.aliases ?? []).join(", "),
    translations,
  };
}

function rowsToEntries(rows: RowForm[]): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const r of rows) {
    const term = r.term.trim();
    if (!term) continue;
    // Trim each translation and drop empty ones; the backend re-derives the
    // legacy en/vi mirrors from this map on save.
    const translations: Record<string, string> = {};
    for (const [code, val] of Object.entries(r.translations)) {
      const v = val.trim();
      if (v) translations[code] = v;
    }
    out.push({
      term,
      aliases: r.aliasesText
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      translations,
    });
  }
  return out;
}

export default function GlossaryModal({
  onClose,
  initialTerm,
}: {
  onClose: () => void;
  /** When set, jump straight into edit view of the active book (auto-creating
   *  a "預設" book if none exists) and append a pre-filled row whose `term`
   *  is this string. Used by the right-click "加入術語表" flow from transcript
   *  selections. */
  initialTerm?: string | null;
}) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [view, setView] = useState<"list" | "edit">("list");
  // Index of the book currently being edited in cfg.glossaries.
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [rows, setRows] = useState<RowForm[]>([]);
  const [bookName, setBookName] = useState("");
  // Language the book being edited authors its `term`s in (defaults zh).
  const [bookSourceLang, setBookSourceLang] = useState<string>("zh");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Tracks whether we've already navigated into the prefill flow. Without
  // this guard, every cfg refresh would re-trigger the initialTerm useEffect
  // and overwrite the user's in-progress edits.
  const [prefillHandled, setPrefillHandled] = useState(false);

  useEffect(() => {
    invoke<Config>("get_config")
      .then(setCfg)
      .catch((e) => setError(`load: ${e}`));
  }, []);

  function openEdit(idx: number, prefillAlias?: string) {
    if (!cfg) return;
    const book = cfg.glossaries[idx];
    setEditingIdx(idx);
    setBookName(book.name);
    setBookSourceLang(book.source_lang ?? "zh");
    const initialRows = book.entries.map(entryToRow);
    if (prefillAlias) {
      // Selections from the transcript come from Whisper's output — i.e. the
      // wrong characters the user wants substituted away from. So they go
      // into aliases; the user fills in the canonical term themselves.
      initialRows.push({
        rowId: `prefill-${Date.now()}`,
        term: "",
        aliasesText: prefillAlias,
        translations: {},
      });
    }
    setRows(initialRows);
    setView("edit");
    setConfirmDelete(false);
  }

  // Right-click prefill flow. Runs once cfg is loaded: pick the active book
  // (or first book, or auto-create one) and jump into edit view with the
  // selected text pre-seated as a new term row.
  useEffect(() => {
    if (!cfg || !initialTerm || prefillHandled) return;
    let idx = cfg.active_glossary
      ? cfg.glossaries.findIndex((b) => b.name === cfg.active_glossary)
      : -1;
    if (idx === -1 && cfg.glossaries.length > 0) {
      idx = 0;
    }
    if (idx === -1) {
      // No books exist — auto-create "預設" and persist, then let the next
      // cfg-update tick of this effect actually open it.
      const seeded: GlossaryBook = { name: "預設", source_lang: "zh", entries: [] };
      const next: Config = {
        ...cfg,
        glossaries: [seeded],
        active_glossary: "預設",
      };
      invoke("set_config", { config: next })
        .then(() => setCfg(next))
        .catch((e) => setError(`save: ${e}`));
      return;
    }
    openEdit(idx, initialTerm);
    setPrefillHandled(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, initialTerm, prefillHandled]);

  function backToList() {
    setView("list");
    setEditingIdx(null);
    setConfirmDelete(false);
  }

  async function persist(nextCfg: Config) {
    try {
      await invoke("set_config", { config: nextCfg });
      setCfg(nextCfg);
      setError(null);
    } catch (e) {
      setError(`save: ${e}`);
    }
  }

  async function handleCreate() {
    if (!cfg) return;
    // Auto-name new books "新術語表" / "新術語表 2" / ... so the user gets
    // a usable default and can rename inline; an empty-name prompt would be
    // a friction point for "I just want to add a few terms".
    const base = "新術語表";
    let name = base;
    let i = 2;
    while (cfg.glossaries.some((b) => b.name === name)) {
      name = `${base} ${i}`;
      i += 1;
    }
    const newBook: GlossaryBook = { name, source_lang: "zh", entries: [] };
    const next: Config = { ...cfg, glossaries: [...cfg.glossaries, newBook] };
    setCfg(next);
    await persist(next);
    openEdit(next.glossaries.length - 1);
  }

  async function handleSetActive(idx: number) {
    if (!cfg) return;
    const targetName = cfg.glossaries[idx].name;
    const next: Config = {
      ...cfg,
      active_glossary: cfg.active_glossary === targetName ? null : targetName,
    };
    await persist(next);
  }

  async function handleSaveBook() {
    if (!cfg || editingIdx === null) return;
    const trimmedName = bookName.trim() || "未命名術語表";
    // Block name collisions (other than the book we're editing).
    const dup = cfg.glossaries.some((b, i) => i !== editingIdx && b.name === trimmedName);
    if (dup) {
      setError(`已有同名術語表「${trimmedName}」`);
      return;
    }
    setSaving(true);
    const oldName = cfg.glossaries[editingIdx].name;
    const updatedBook: GlossaryBook = {
      name: trimmedName,
      source_lang: bookSourceLang,
      entries: rowsToEntries(rows),
    };
    const nextBooks = cfg.glossaries.map((b, i) => (i === editingIdx ? updatedBook : b));
    // Rename: if this book was active and got renamed, point active_glossary
    // at the new name so the activation isn't silently lost.
    const nextActive =
      cfg.active_glossary === oldName ? trimmedName : cfg.active_glossary;
    const next: Config = {
      ...cfg,
      glossaries: nextBooks,
      active_glossary: nextActive,
    };
    await persist(next);
    setSaving(false);
    backToList();
  }

  async function handleDeleteBook() {
    if (!cfg || editingIdx === null) return;
    const removedName = cfg.glossaries[editingIdx].name;
    const nextBooks = cfg.glossaries.filter((_, i) => i !== editingIdx);
    const nextActive = cfg.active_glossary === removedName ? null : cfg.active_glossary;
    const next: Config = {
      ...cfg,
      glossaries: nextBooks,
      active_glossary: nextActive,
    };
    await persist(next);
    backToList();
  }

  function addRow() {
    setRows((rs) => [
      ...rs,
      {
        rowId: `new-${Date.now()}-${rs.length}`,
        term: "",
        aliasesText: "",
        translations: {},
      },
    ]);
  }

  function updateRow(rowId: string, patch: Partial<RowForm>) {
    setRows((rs) => rs.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  }

  function removeRow(rowId: string) {
    setRows((rs) => rs.filter((r) => r.rowId !== rowId));
  }

  return (
    <div className="absolute inset-0 z-10 flex items-stretch justify-center bg-paper-900/30 p-4">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-lg border border-paper-200 bg-white shadow-xl">
        <header className="flex flex-shrink-0 items-center justify-between border-b border-paper-200 px-5 py-3">
          <div className="flex items-center gap-2">
            {view === "edit" && (
              <button
                className="text-paper-500 hover:text-paper-900"
                onClick={backToList}
                aria-label="返回"
                title="返回"
              >
                ←
              </button>
            )}
            <h2 className="text-lg font-semibold">
              {view === "list" ? "術語表" : "編輯術語表"}
            </h2>
          </div>
          <button
            className="text-paper-500 hover:text-paper-900"
            onClick={onClose}
            aria-label="關閉"
          >
            ✕
          </button>
        </header>

        {!cfg ? (
          <p className="px-5 py-6 text-sm text-paper-600">載入中…</p>
        ) : view === "list" ? (
          <ListView
            books={cfg.glossaries}
            activeName={cfg.active_glossary}
            configSource={cfg.language.source}
            onEdit={openEdit}
            onToggleActive={handleSetActive}
            onCreate={handleCreate}
          />
        ) : (
          <EditView
            bookName={bookName}
            setBookName={setBookName}
            bookSourceLang={bookSourceLang}
            setBookSourceLang={setBookSourceLang}
            rows={rows}
            updateRow={updateRow}
            removeRow={removeRow}
            addRow={addRow}
            onSave={handleSaveBook}
            onDelete={handleDeleteBook}
            confirmDelete={confirmDelete}
            setConfirmDelete={setConfirmDelete}
            saving={saving}
          />
        )}

        {error && (
          <p className="mx-5 mb-3 rounded bg-danger-50 px-3 py-2 text-xs text-danger-700">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function ListView({
  books,
  activeName,
  configSource,
  onEdit,
  onToggleActive,
  onCreate,
}: {
  books: GlossaryBook[];
  activeName: string | null;
  configSource: string;
  onEdit: (idx: number) => void;
  onToggleActive: (idx: number) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
      <p className="text-xs text-paper-600">
        術語表會在錄音時偏置 Whisper 辨識、修正常見錯字，並要求翻譯 / 會議總結使用對應譯名。
        同一時間只有一本「使用中」。
      </p>

      {books.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-paper-300 bg-paper-50 px-4 py-6 text-center text-sm text-paper-600">
          <p className="mb-1 font-medium text-paper-700">還沒有術語表</p>
          <p className="text-xs">建一本來提升 STT 與翻譯一致性</p>
        </div>
      ) : (
        books.map((book, idx) => {
          const isActive = book.name === activeName;
          const bookSource = book.source_lang ?? "zh";
          return (
            <div
              key={book.name}
              className={`rounded-xl border p-3 transition ${
                isActive
                  ? "border-paper-900 bg-paper-50"
                  : "border-paper-200 bg-white hover:border-paper-400"
              }`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-paper-900">{book.name}</p>
                  <p className="text-xs text-paper-500">
                    {book.entries.length} 條術語
                    <span className="ml-2 rounded-full border border-paper-300 px-1.5 py-0.5 text-[10px] text-paper-600">
                      {zhName(bookSource)}
                    </span>
                    {isActive && (
                      <span className="ml-2 rounded-full bg-paper-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        使用中
                      </span>
                    )}
                    {isActive && bookSource !== configSource && (
                      <span className="ml-2 rounded-full border border-warn-300 bg-warn-50 px-1.5 py-0.5 text-[10px] font-medium text-warn-900">
                        與目前來源語言不同
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 text-xs">
                <button
                  className="flex-1 rounded border border-paper-300 px-3 py-1.5 text-paper-700 hover:bg-paper-100"
                  onClick={() => onEdit(idx)}
                >
                  編輯
                </button>
                <button
                  className={`flex-1 rounded px-3 py-1.5 font-medium transition ${
                    isActive
                      ? "border border-paper-300 text-paper-700 hover:bg-paper-100"
                      : "bg-paper-900 text-white hover:bg-paper-700"
                  }`}
                  onClick={() => onToggleActive(idx)}
                >
                  {isActive ? "停用" : "使用"}
                </button>
              </div>
            </div>
          );
        })
      )}

      <button
        type="button"
        className="w-full rounded-xl border border-dashed border-paper-300 px-3 py-3 text-sm text-paper-600 transition hover:border-paper-500 hover:text-paper-900"
        onClick={onCreate}
      >
        + 新建術語表
      </button>
    </div>
  );
}

function EditView({
  bookName,
  setBookName,
  bookSourceLang,
  setBookSourceLang,
  rows,
  updateRow,
  removeRow,
  addRow,
  onSave,
  onDelete,
  confirmDelete,
  setConfirmDelete,
  saving,
}: {
  bookName: string;
  setBookName: (s: string) => void;
  bookSourceLang: string;
  setBookSourceLang: (s: string) => void;
  rows: RowForm[];
  updateRow: (rowId: string, patch: Partial<RowForm>) => void;
  removeRow: (rowId: string) => void;
  addRow: () => void;
  onSave: () => void;
  onDelete: () => void;
  confirmDelete: boolean;
  setConfirmDelete: (b: boolean) => void;
  saving: boolean;
}) {
  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-paper-700">名稱</label>
          <input
            type="text"
            className="w-full rounded border border-paper-300 px-2 py-1 text-sm font-medium"
            value={bookName}
            onChange={(e) => setBookName(e.target.value)}
            placeholder="例：紫微命理會議"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-paper-700">術語語言</label>
          <select
            className="w-full rounded border border-paper-300 px-2 py-1 text-sm"
            value={bookSourceLang}
            onChange={(e) => setBookSourceLang(e.target.value)}
          >
            {LANGS.filter((l) => l.source_capable).map((l) => (
              <option key={l.code} value={l.code}>
                {selectLabel(l.code)}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-paper-500">
            這本術語表詞條使用的語言（通常與來源語言相同）
          </p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium text-paper-700">
              術語列表（{rows.length}）
            </label>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-paper-300 bg-paper-50 p-3 text-xs">
              <p className="mb-2 text-paper-600">
                還沒有任何術語。下面是個範例 — 可以參考格式：
              </p>
              <ExampleCard entry={EXAMPLE_ENTRY} />
            </div>
          ) : (
            <div className="space-y-2">
              {rows.map((row) => (
                <RowEditor
                  key={row.rowId}
                  row={row}
                  bookSourceLang={bookSourceLang}
                  onChange={(patch) => updateRow(row.rowId, patch)}
                  onRemove={() => removeRow(row.rowId)}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            className="mt-2 w-full rounded border border-dashed border-paper-300 px-3 py-2 text-xs text-paper-600 transition hover:border-paper-500 hover:text-paper-900"
            onClick={addRow}
          >
            + 新增術語
          </button>
        </div>
      </div>

      <footer className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-paper-200 px-5 py-3">
        {confirmDelete ? (
          <>
            <span className="text-xs text-danger-700">確定刪除整本？</span>
            <div className="flex gap-2">
              <button
                className="rounded px-3 py-1.5 text-sm text-paper-600 hover:bg-paper-100"
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </button>
              <button
                className="rounded bg-danger-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-danger-900"
                onClick={onDelete}
              >
                刪除
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              className="rounded px-3 py-1.5 text-xs text-danger-700 hover:bg-danger-50"
              onClick={() => setConfirmDelete(true)}
            >
              刪除整本
            </button>
            <button
              className="rounded bg-paper-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-paper-700 disabled:bg-paper-400"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? "儲存中…" : "儲存"}
            </button>
          </>
        )}
      </footer>
    </>
  );
}

function RowEditor({
  row,
  bookSourceLang,
  onChange,
  onRemove,
}: {
  row: RowForm;
  bookSourceLang: string;
  onChange: (patch: Partial<RowForm>) => void;
  onRemove: () => void;
}) {
  // A translation input per registry language except the book's own source —
  // there is nothing to translate a term into its own language.
  const targetLangs = LANGS.filter((l) => l.code !== bookSourceLang);
  return (
    <div className="rounded border border-paper-200 bg-white p-2 text-xs">
      <div className="mb-1.5 flex items-start gap-1.5">
        <div className="flex-1">
          <p className="mb-0.5 text-[10px] font-medium text-paper-700">
            {`正確的${zhName(bookSourceLang)}`}
          </p>
          <input
            type="text"
            placeholder="例：紫微斗數"
            className="w-full rounded border border-paper-300 px-2 py-1 font-medium"
            value={row.term}
            onChange={(e) => onChange({ term: e.target.value })}
          />
        </div>
        <button
          type="button"
          className="mt-4 rounded px-1.5 py-1 text-paper-500 hover:bg-danger-50 hover:text-danger-700"
          onClick={onRemove}
          aria-label="刪除"
          title="刪除"
        >
          ✕
        </button>
      </div>
      <p className="mb-0.5 text-[10px] font-medium text-paper-700">
        常見錯字 <span className="font-normal text-paper-500">（可用，隔開輸入多個）</span>
      </p>
      <input
        type="text"
        placeholder="例：紫薇斗數, 子位斗數"
        className="mb-1.5 w-full rounded border border-paper-300 px-2 py-1"
        value={row.aliasesText}
        onChange={(e) => onChange({ aliasesText: e.target.value })}
      />
      <div className="grid grid-cols-2 gap-1.5">
        {targetLangs.map((l) => (
          <input
            key={l.code}
            type="text"
            placeholder={`${zhName(l.code)}譯名`}
            className="rounded border border-paper-300 px-2 py-1"
            value={row.translations[l.code] ?? ""}
            onChange={(e) =>
              onChange({ translations: { ...row.translations, [l.code]: e.target.value } })
            }
          />
        ))}
      </div>
    </div>
  );
}

function ExampleCard({ entry }: { entry: GlossaryEntry }) {
  const parts = Object.entries(entry.translations).map(
    ([code, text]) => `${code.toUpperCase()}：${text}`,
  );
  return (
    <div className="rounded border border-paper-200 bg-white p-2 opacity-70">
      <p className="font-medium text-paper-900">{entry.term}</p>
      <p className="text-paper-500">常見錯字：{entry.aliases.join(", ")}</p>
      <p className="text-paper-500">{parts.join(" ／ ")}</p>
    </div>
  );
}
