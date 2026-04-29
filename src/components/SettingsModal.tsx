import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Config } from "@/lib/types";

const MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6"];

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showDeepgram, setShowDeepgram] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Config>("get_config")
      .then(setCfg)
      .catch((e) => setError(`load: ${e}`));
  }, []);

  async function handleSave() {
    if (!cfg) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("set_config", { config: cfg });
      onClose();
    } catch (e) {
      setError(`save: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  function update(patch: Partial<Config["api"]>) {
    if (!cfg) return;
    setCfg({ ...cfg, api: { ...cfg.api, ...patch } });
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <header className="flex items-center justify-between border-b border-stone-200 pb-3">
          <h2 className="text-lg font-semibold">設定</h2>
          <button
            className="text-stone-400 hover:text-stone-700"
            onClick={onClose}
            aria-label="關閉"
          >
            ✕
          </button>
        </header>

        {!cfg ? (
          <p className="py-6 text-sm text-stone-500">載入中…</p>
        ) : (
          <div className="space-y-4 py-4 text-sm">
            <Field
              label="Anthropic API key"
              hint="從 console.anthropic.com 建立"
            >
              <div className="flex gap-2">
                <input
                  type={showAnthropic ? "text" : "password"}
                  className="flex-1 rounded border border-stone-300 px-2 py-1 font-mono text-xs"
                  value={cfg.api.anthropic_api_key}
                  onChange={(e) => update({ anthropic_api_key: e.target.value })}
                  placeholder="sk-ant-api03-..."
                />
                <button
                  className="rounded border border-stone-300 px-2 text-xs text-stone-600 hover:bg-stone-50"
                  onClick={() => setShowAnthropic(!showAnthropic)}
                >
                  {showAnthropic ? "隱藏" : "顯示"}
                </button>
              </div>
            </Field>

            <Field
              label="Deepgram API key"
              hint="僅 cloud backend 使用；console.deepgram.com"
            >
              <div className="flex gap-2">
                <input
                  type={showDeepgram ? "text" : "password"}
                  className="flex-1 rounded border border-stone-300 px-2 py-1 font-mono text-xs"
                  value={cfg.api.deepgram_api_key}
                  onChange={(e) => update({ deepgram_api_key: e.target.value })}
                  placeholder="（可留空）"
                />
                <button
                  className="rounded border border-stone-300 px-2 text-xs text-stone-600 hover:bg-stone-50"
                  onClick={() => setShowDeepgram(!showDeepgram)}
                >
                  {showDeepgram ? "隱藏" : "顯示"}
                </button>
              </div>
            </Field>

            <Field label="翻譯模型">
              <select
                className="w-full rounded border border-stone-300 px-2 py-1"
                value={cfg.api.model}
                onChange={(e) => update({ model: e.target.value })}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="檔案">
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
                  onClick={() => invoke("open_config_folder").catch((e) => setError(`open: ${e}`))}
                  type="button"
                >
                  📂 設定資料夾
                </button>
                <button
                  className="rounded border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
                  onClick={() => invoke("open_errors_log").catch((e) => setError(`open: ${e}`))}
                  type="button"
                >
                  📝 錯誤紀錄
                </button>
              </div>
            </Field>
          </div>
        )}

        {error && (
          <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        )}

        <footer className="flex justify-end gap-2 border-t border-stone-200 pt-3">
          <button
            className="rounded px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-stone-300"
            onClick={handleSave}
            disabled={!cfg || saving}
          >
            {saving ? "儲存中…" : "儲存"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-stone-700">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-stone-400">{hint}</p>}
    </div>
  );
}
