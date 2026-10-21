import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AudioDevice, Config } from "@/lib/types";
import { LANGS, selectLabel, zhName } from "@/lib/languages";
import { formatUsd } from "@/lib/cost";

type Backend = "local" | "openai";

/**
 * The console's right-column "本場設定" card. Since 0.1.29 this IS the
 * per-meeting editor (the Settings modal no longer has a 會議 tab): every
 * control writes straight to config via `set_config`, and the console picks
 * the change up through its `config:changed` / `language:changed` listeners.
 *
 * The card renders from `cfg` (the console's snapshot) but keeps an
 * optimistic local copy so a select doesn't snap back while the round-trip
 * to Rust is in flight.
 */
const DEVICE_LIST_ATTEMPTS = 3;
const DEVICE_LIST_RETRY_MS = 2000;

export default function SessionSetupCard({
  cfg,
  running,
  useMic,
  sidecarReady,
  micLabel,
  costUsd,
  targetCount,
  anySlotClosed,
  onOpenWindows,
  onOpenAccount,
  onError,
}: {
  cfg: Config | null;
  running: boolean;
  useMic: boolean;
  /** The STT engine answered `ready`. Devices are listed by the engine, so
   *  asking before that (cold start) can only time out. */
  sidecarReady: boolean;
  /** Human label for the mic chip when the device select is hidden. */
  micLabel: string;
  costUsd: number | null;
  targetCount: number;
  anySlotClosed: boolean;
  onOpenWindows: () => void;
  onOpenAccount: () => void;
  onError: (message: string) => void;
}) {
  const [local, setLocal] = useState<Config | null>(cfg);
  const [devices, setDevices] = useState<AudioDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlight = useRef(false);

  useEffect(() => {
    setLocal(cfg);
  }, [cfg]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The engine may still be busy right after launch (imports, model load),
  // so a timeout is retried a couple of times before it is shown.
  const refreshDevices = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const list = await invoke<AudioDevice[]>("list_audio_devices");
          if (!mountedRef.current) return;
          setDevices(list);
          setDevicesError(null);
          return;
        } catch (e) {
          if (!mountedRef.current) return;
          if (attempt >= DEVICE_LIST_ATTEMPTS) {
            setDevicesError(String(e));
            setDevices([]);
            return;
          }
          await new Promise((r) => setTimeout(r, DEVICE_LIST_RETRY_MS));
        }
      }
    } finally {
      refreshInFlight.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (useMic && sidecarReady) refreshDevices();
  }, [useMic, sidecarReady, refreshDevices]);

  function showNote(text: string) {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 6000);
  }

  function commit(next: Config) {
    setLocal(next);
    invoke("set_config", { config: next }).catch((e) => onError(`儲存設定失敗：${e}`));
  }

  function changeSource(newSource: string) {
    if (!local || newSource === local.language.source) return;
    const oldSource = local.language.source;
    const slots = [...local.language.target_slots];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === newSource) {
        slots[i] = oldSource;
        showNote(`譯文${i === 0 ? "一" : "二"}已改為${zhName(oldSource)}（原本與來源相同）`);
      }
    }
    commit({ ...local, language: { source: newSource, target_slots: slots } });
  }

  function changeSlot(idx: number, value: string) {
    if (!local) return;
    const slots = [...local.language.target_slots];
    slots[idx] = value;
    commit({ ...local, language: { ...local.language, target_slots: slots } });
  }

  function changeBackend(b: Backend) {
    if (!local) return;
    commit({ ...local, stt: { ...local.stt, backend: b } });
  }

  function changeDevice(name: string) {
    if (!local) return;
    commit({ ...local, audio: { ...local.audio, input_device: name } });
  }

  if (!local) {
    return (
      <div className="border-b border-paper-200 bg-white px-[18px] py-4">
        <h3 className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-paper-600">
          本場設定
        </h3>
        <p className="text-xs text-paper-500">載入中…</p>
      </div>
    );
  }

  const backend: Backend = local.stt?.backend === "openai" ? "openai" : "local";
  const openaiKeyMissing = backend === "openai" && !local.api.openai_api_key.trim();
  const device = local.audio.input_device;
  // Unknown until the engine has listed devices — don't call it 未連接 yet.
  const deviceMissing = device !== "" && devices !== null && !devices.some((d) => d.name === device);

  return (
    <div className="border-b border-paper-200 bg-white px-[18px] py-4">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-paper-600">
          本場設定
        </h3>
        {running && <span className="text-[11px] text-paper-500">錄音中不可變更</span>}
      </div>

      <dl className="grid grid-cols-[44px_1fr] items-center gap-x-2.5 gap-y-2 text-[13px]">
        <dt className="text-paper-500">來源</dt>
        <dd>
          <select
            className={SELECT}
            value={local.language.source}
            onChange={(e) => changeSource(e.target.value)}
            disabled={running}
            aria-label="來源語言"
          >
            {LANGS.filter((l) => l.source_capable).map((l) => (
              <option key={l.code} value={l.code}>
                {selectLabel(l.code)}
              </option>
            ))}
          </select>
        </dd>

        <dt className="text-paper-500">譯文一</dt>
        <dd>
          <select
            className={SELECT}
            value={local.language.target_slots[0]}
            onChange={(e) => changeSlot(0, e.target.value)}
            disabled={running}
            aria-label="譯文視窗一語言"
          >
            {slotOptions(local.language.source, local.language.target_slots[1], "二")}
          </select>
        </dd>

        <dt className="text-paper-500">譯文二</dt>
        <dd>
          <select
            className={SELECT}
            value={local.language.target_slots[1]}
            onChange={(e) => changeSlot(1, e.target.value)}
            disabled={running}
            aria-label="譯文視窗二語言"
          >
            <option value="">不使用</option>
            {slotOptions(local.language.source, local.language.target_slots[0], "一")}
          </select>
        </dd>

        <dt className="text-paper-500">辨識</dt>
        <dd>
          <select
            className={SELECT}
            value={backend}
            onChange={(e) => changeBackend(e.target.value as Backend)}
            disabled={running}
            aria-label="辨識引擎"
          >
            <option value="local">本機（免費，離線可用）</option>
            <option value="openai">雲端 OpenAI（較快，計費）</option>
          </select>
        </dd>

        <dt className="text-paper-500">麥克風</dt>
        <dd>
          {useMic ? (
            <div className="flex gap-1.5">
              <select
                className={`min-w-0 flex-1 ${SELECT}`}
                value={device}
                onChange={(e) => changeDevice(e.target.value)}
                disabled={running}
                aria-label="麥克風裝置"
                title={device || "系統預設"}
              >
                <option value="">系統預設</option>
                {device !== "" && (deviceMissing || devices === null) && (
                  <option value={device}>{deviceMissing ? `${device}（未連接）` : device}</option>
                )}
                {(devices ?? []).map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100 disabled:opacity-50"
                onClick={refreshDevices}
                disabled={refreshing || running}
                aria-label="重新整理裝置清單"
                title="插拔麥克風後重新整理"
              >
                {refreshing ? "…" : "↻"}
              </button>
            </div>
          ) : (
            <span className="truncate text-paper-900" title={micLabel}>
              {micLabel}
            </span>
          )}
        </dd>

        <dt className="text-paper-500">估算</dt>
        <dd
          className="font-mono text-[12px] tabular-nums text-paper-900"
          title="翻譯（＋雲端辨識）費用概估，每小時約 30 分鐘語音"
        >
          {formatUsd(costUsd)} / 小時
        </dd>
      </dl>

      {(note || devicesError || openaiKeyMissing || backend === "openai") && (
        <div className="mt-2.5 space-y-1 text-[11px] leading-snug">
          {note && <p className="text-paper-700">{note}</p>}
          {devicesError && <p className="break-all text-danger-700">無法列出裝置：{devicesError}</p>}
          {openaiKeyMissing ? (
            <p className="text-warn-700">
              雲端辨識需要 OpenAI key。
              <button type="button" className="ml-1 text-ai-blue hover:underline" onClick={onOpenAccount}>
                到帳號設定
              </button>
            </p>
          ) : backend === "openai" ? (
            <p className="text-paper-500">音訊會傳送至 OpenAI；術語表會作為辨識提示。</p>
          ) : null}
        </div>
      )}

      <button
        className="mt-3 w-full rounded-lg border border-paper-200 bg-white px-2 py-1.5 text-xs text-paper-800 hover:bg-paper-50 disabled:opacity-50"
        onClick={onOpenWindows}
        disabled={targetCount === 0}
        type="button"
        title={anySlotClosed ? "重新開啟被關閉的譯文視窗" : "把譯文視窗帶到最前面"}
      >
        {anySlotClosed ? "重新開啟譯文視窗 ↗" : "開啟譯文視窗 ↗"}
      </button>
    </div>
  );
}

const SELECT =
  "w-full rounded-md border border-paper-300 bg-white px-1.5 py-1 text-[13px] text-paper-900 focus:outline-none focus:ring-2 focus:ring-ai-blue/40 disabled:cursor-not-allowed disabled:bg-paper-50 disabled:text-paper-500";

// Language <option>s for a translation-slot select. A code is disabled when it
// equals the source language or is already used by the other slot, so the
// same language can't drive both windows.
function slotOptions(source: string, otherSlot: string, otherName: "一" | "二") {
  return LANGS.map((l) => {
    const sameAsSource = l.code === source;
    const usedByOther = otherSlot !== "" && l.code === otherSlot;
    return (
      <option
        key={l.code}
        value={l.code}
        disabled={sameAsSource || usedByOther}
        title={sameAsSource ? "與來源語言相同" : usedByOther ? `已用於譯文${otherName}` : undefined}
      >
        {selectLabel(l.code)}
      </option>
    );
  });
}
