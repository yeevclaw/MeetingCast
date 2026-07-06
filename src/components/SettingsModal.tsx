import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { AudioDevice, Config } from "@/lib/types";

const MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6"];
const SUMMARY_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5"];

type Backend = "local" | "cloud" | "openai";

export default function SettingsModal({
  onClose,
  backend,
  setBackend,
  useMic,
  setUseMic,
  running,
}: {
  onClose: () => void;
  backend: Backend;
  setBackend: (b: Backend) => void;
  useMic: boolean;
  setUseMic: (v: boolean) => void;
  running: boolean;
}) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showDeepgram, setShowDeepgram] = useState(false);
  const [showOpenai, setShowOpenai] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [devices, setDevices] = useState<AudioDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  // Dedup concurrent refreshes — without this, React StrictMode's double-
  // mount fires two list_audio_devices in flight simultaneously, the second
  // overwrites the first's oneshot in the Rust side, and the first call
  // surfaces a spurious "sidecar dropped response" even though devices
  // ultimately come back fine.
  const refreshInFlightRef = useRef(false);

  const refreshDevices = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setRefreshingDevices(true);
    try {
      const list = await invoke<AudioDevice[]>("list_audio_devices");
      setDevices(list);
      setDevicesError(null);
    } catch (e) {
      setDevicesError(String(e));
      setDevices([]);
    } finally {
      refreshInFlightRef.current = false;
      setRefreshingDevices(false);
    }
  }, []);

  useEffect(() => {
    invoke<Config>("get_config")
      .then(setCfg)
      .catch((e) => setError(`load: ${e}`));
    getVersion().then(setVersion).catch(() => {});
    refreshDevices();
  }, [refreshDevices]);

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

  function updateAudio(patch: Partial<Config["audio"]>) {
    if (!cfg) return;
    setCfg({ ...cfg, audio: { ...cfg.audio, ...patch } });
  }

  function updateIdleMinutes(v: number) {
    if (!cfg) return;
    setCfg({ ...cfg, idle_auto_stop_minutes: v });
  }

  return (
    <div className="absolute inset-0 z-10 flex items-stretch justify-center bg-paper-900/30 p-4">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-lg border border-paper-200 bg-white shadow-xl">
        <header className="flex flex-shrink-0 items-center justify-between border-b border-paper-200 px-5 py-3">
          <h2 className="text-lg font-semibold">設定</h2>
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
        ) : (
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
            <Field
              label="Anthropic API key"
              hint="從 console.anthropic.com 建立"
            >
              <div className="flex gap-2">
                <input
                  type={showAnthropic ? "text" : "password"}
                  className="flex-1 rounded border border-paper-300 px-2 py-1 font-mono text-xs"
                  value={cfg.api.anthropic_api_key}
                  onChange={(e) => update({ anthropic_api_key: e.target.value })}
                  placeholder="sk-ant-api03-..."
                />
                <button
                  className="rounded border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100"
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
                  className="flex-1 rounded border border-paper-300 px-2 py-1 font-mono text-xs"
                  value={cfg.api.deepgram_api_key}
                  onChange={(e) => update({ deepgram_api_key: e.target.value })}
                  placeholder="（可留空）"
                />
                <button
                  className="rounded border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100"
                  onClick={() => setShowDeepgram(!showDeepgram)}
                >
                  {showDeepgram ? "隱藏" : "顯示"}
                </button>
              </div>
            </Field>

            <Field
              label="OpenAI API key"
              hint="僅 openai backend 使用；platform.openai.com/api-keys"
            >
              <div className="flex gap-2">
                <input
                  type={showOpenai ? "text" : "password"}
                  className="flex-1 rounded border border-paper-300 px-2 py-1 font-mono text-xs"
                  value={cfg.api.openai_api_key}
                  onChange={(e) => update({ openai_api_key: e.target.value })}
                  placeholder="（可留空）"
                />
                <button
                  className="rounded border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100"
                  onClick={() => setShowOpenai(!showOpenai)}
                >
                  {showOpenai ? "隱藏" : "顯示"}
                </button>
              </div>
            </Field>

            <Field label="翻譯模型">
              <select
                className="w-full rounded border border-paper-300 px-2 py-1"
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

            <Field label="總結模型" hint="會議紀錄的 AI 總結使用；預設 Sonnet 4.6">
              <select
                className="w-full rounded border border-paper-300 px-2 py-1"
                value={cfg.api.summary_model}
                onChange={(e) => update({ summary_model: e.target.value })}
              >
                {SUMMARY_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="辨識引擎"
              hint={
                running
                  ? "錄音中無法切換，請先停止"
                  : "預設 mlx-whisper（免費、離線可用）；cloud / openai 需填對應 API key"
              }
            >
              <select
                className="w-full rounded border border-paper-300 px-2 py-1 disabled:opacity-50"
                value={backend}
                onChange={(e) => setBackend(e.target.value as Backend)}
                disabled={running}
              >
                <option value="local">local (mlx-whisper)</option>
                <option value="cloud">cloud (deepgram)</option>
                <option value="openai">openai (realtime-whisper)</option>
              </select>
              {backend === "openai" && (
                <p className="mt-2 rounded border border-warn-200 bg-warn-50 px-2 py-1.5 text-xs text-warn-900">
                  ⚠ OpenAI Realtime Whisper 僅輸出簡體中文，且不支援術語表注入。
                  優點：邊講邊出字（live captioning）、技術詞彙準確度較佳。
                </p>
              )}
            </Field>

            <Field
              label="音源"
              hint={running ? "錄音中無法切換，請先停止" : "預設使用麥克風；取消勾選則跑 weather demo"}
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-paper-900 disabled:opacity-50"
                  checked={useMic}
                  onChange={(e) => setUseMic(e.target.checked)}
                  disabled={running}
                />
                使用麥克風
              </label>
            </Field>

            {useMic && (
              <Field
                label="麥克風裝置"
                hint={
                  running
                    ? "錄音中無法切換，請先停止"
                    : "拔插藍芽耳機或外接麥克風後可按 ↻ 重新整理"
                }
              >
                <div className="flex gap-2">
                  <select
                    className="flex-1 rounded border border-paper-300 px-2 py-1 disabled:opacity-50"
                    value={cfg.audio.input_device}
                    onChange={(e) => updateAudio({ input_device: e.target.value })}
                    disabled={running}
                  >
                    <option value="">系統預設</option>
                    {/* 已選裝置目前不在清單中（被拔掉了）— 仍保留為選項，
                        標 "(未連接)" 提示，避免儲存時被靜默清掉。 */}
                    {cfg.audio.input_device &&
                      !(devices ?? []).some((d) => d.name === cfg.audio.input_device) && (
                        <option value={cfg.audio.input_device}>
                          {cfg.audio.input_device}（未連接）
                        </option>
                      )}
                    {(devices ?? []).map((d) => (
                      <option key={d.name} value={d.name}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100 disabled:opacity-50"
                    onClick={refreshDevices}
                    disabled={refreshingDevices || running}
                    aria-label="重新整理裝置清單"
                    title="重新整理"
                  >
                    {refreshingDevices ? "…" : "↻"}
                  </button>
                </div>
                {devicesError && (
                  <p className="mt-1 break-all text-xs text-danger-700">
                    無法列出裝置：{devicesError}
                  </p>
                )}
              </Field>
            )}

            <Field
              label="閒置自動停止（分鐘）"
              hint="超過設定分鐘無人說話則自動停止，避免 OpenAI 雲端方案空轉計費；0 = 停用"
            >
              <input
                type="number"
                min={0}
                max={120}
                step={1}
                className="w-24 rounded border border-paper-300 px-2 py-1"
                value={cfg.idle_auto_stop_minutes}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateIdleMinutes(Number.isFinite(v) && v >= 0 ? v : 0);
                }}
              />
            </Field>

            <Field label="檔案">
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded border border-paper-300 px-2 py-1 text-xs text-paper-700 hover:bg-paper-100"
                  onClick={() => invoke("open_config_folder").catch((e) => setError(`open: ${e}`))}
                  type="button"
                >
                  📂 設定資料夾
                </button>
                <button
                  className="rounded border border-paper-300 px-2 py-1 text-xs text-paper-700 hover:bg-paper-100"
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
          <p className="mx-5 mb-2 rounded bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</p>
        )}

        <footer className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-paper-200 px-5 py-3">
          <span className="text-[11px] tabular-nums text-paper-500">
            {version ? `MeetingCast v${version}` : ""}
          </span>
          <div className="flex gap-2">
            <button
              className="rounded px-3 py-1.5 text-sm text-paper-600 hover:bg-paper-100"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="rounded bg-paper-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-paper-700 disabled:bg-paper-400"
              onClick={handleSave}
              disabled={!cfg || saving}
            >
              {saving ? "儲存中…" : "儲存"}
            </button>
          </div>
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
      <label className="mb-1 block text-xs font-medium text-paper-700">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-paper-500">{hint}</p>}
    </div>
  );
}
