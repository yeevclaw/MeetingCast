import { rmsToLevel } from "@/components/MicMeter";
import { StepIcon, type StepStatus } from "@/components/PrewarmChecklist";
import { useSttLevel } from "@/lib/useSttLevel";

/**
 * One recording run's startup, from the 開始 click until it is really
 * listening. Each step is ticked by the event that proves it, not by a timer:
 *   - mic:    `stt:stage` mic_ready (the first audio frame was captured)
 *   - engine: local → `stt:started` (sent after the model is loaded);
 *             cloud → `stt:stage` stt_connected (first websocket is up)
 * Both run in parallel — cloud audio captured during the handshake is
 * buffered, nothing is lost.
 */
export type BootState = {
  /** Date.now() of the click — drives the "this is taking long" hints. */
  since: number;
  backend: "local" | "openai";
  /** Demo WAV instead of a microphone. */
  demo: boolean;
  mic: StepStatus;
  engine: StepStatus;
  /** Local only: Date.now() when the model was ready. The local sidecar opens
   *  the mic only after the model load, so the mic step's clock starts here
   *  (a slow load must not read as a mic problem). */
  engineDoneAt?: number;
};

/** After this long a pending step gets a hint; after the second, actions. */
export const MIC_HINT_MS = 4_000;
export const MIC_STUCK_MS = 15_000;
export const ENGINE_HINT_MS = 8_000;
export const ENGINE_STUCK_MS = 25_000;
/** A local model load (already cached — prewarm gates 開始) past this is stuck. */
export const MODEL_LOAD_STUCK_MS = 120_000;

export function bootDone(b: BootState): boolean {
  return b.mic === "done" && b.engine === "done";
}

type Row = { id: "mic" | "engine"; label: string; status: StepStatus; hint?: string; stuck?: boolean };

export function bootRows(b: BootState, elapsedMs: number, modelLoading: boolean): Row[] {
  // Every path gets a way out: whatever stays unticked past its stuck
  // threshold offers 重新開始, so a wedged engine never leaves the console
  // on a disabled 啟動中 button.
  const mic: Row = {
    id: "mic",
    label: b.demo ? "讀取示範音檔" : "開啟麥克風",
    status: b.mic,
  };
  // Cloud opens the mic right away; local only once the model is loaded.
  const micElapsed =
    b.backend === "local" ? (b.engineDoneAt == null ? 0 : b.since + elapsedMs - b.engineDoneAt) : elapsedMs;
  if (b.mic !== "done") {
    if (micElapsed >= MIC_STUCK_MS) {
      mic.stuck = true;
      mic.hint = b.demo
        ? "示範音檔一直沒有開始播放，請重新開始"
        : "麥克風一直沒有送出聲音。請確認已在系統設定允許 MeetingCast 使用麥克風，或重新開始";
    } else if (!b.demo && micElapsed >= MIC_HINT_MS) {
      mic.hint = "若畫面上出現 macOS 麥克風授權視窗，請按「允許」";
    }
  }
  const engine: Row = {
    id: "engine",
    label: b.backend === "openai" ? "連線雲端辨識" : "準備本機辨識模型",
    status: b.engine,
  };
  if (b.engine !== "done") {
    if (b.backend === "local") {
      if (modelLoading && elapsedMs >= MODEL_LOAD_STUCK_MS) {
        engine.stuck = true;
        engine.hint = "模型載入時間過長，請重新開始";
      } else if (modelLoading) {
        engine.hint = "首次載入模型需要多等一下";
      } else if (elapsedMs >= ENGINE_STUCK_MS) {
        engine.stuck = true;
        engine.hint = "辨識引擎沒有回應，請重新開始";
      }
    } else if (elapsedMs >= ENGINE_STUCK_MS) {
      engine.stuck = true;
      engine.hint = "雲端一直連不上。請檢查網路，或改用本機辨識後重新開始";
    } else if (elapsedMs >= ENGINE_HINT_MS) {
      engine.hint = "連線較慢，持續嘗試中…這段期間說的話會先保留";
    }
  }
  return [mic, engine];
}

/** The 啟動中 card shown in the transcript area while a run starts. */
export default function StartupProgress({
  boot,
  elapsedMs,
  modelLoading,
  onRestart,
  onOpenMicSettings,
}: {
  boot: BootState;
  elapsedMs: number;
  modelLoading: boolean;
  onRestart: () => void;
  onOpenMicSettings: () => void;
}) {
  const rows = bootRows(boot, elapsedMs, modelLoading);
  const micStuck = !boot.demo && rows[0].stuck === true;
  const anyStuck = rows.some((r) => r.stuck);
  return (
    <div className="flex h-full flex-col items-center justify-center" role="status" aria-live="polite">
      <div className="w-[340px] rounded-2xl border border-paper-200 bg-white px-6 py-5 shadow-sm">
        <p className="mb-4 text-center font-medium text-paper-900">正在開始錄音…</p>
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-3 text-sm">
              <StepIcon status={r.status} stalled={r.stuck} />
              <div className="flex-1">
                <p
                  className={
                    r.status === "done"
                      ? "text-paper-500 line-through decoration-paper-300"
                      : "font-medium text-paper-900"
                  }
                >
                  {r.label}
                </p>
                {r.hint && r.status !== "done" && (
                  <p className={`mt-0.5 text-[11px] ${r.stuck ? "text-warn-700" : "text-paper-500"}`}>{r.hint}</p>
                )}
              </div>
            </li>
          ))}
          <li className="flex items-start gap-3 text-sm">
            <StepIcon status="pending" />
            <p className="flex-1 text-paper-500">開始聆聽</p>
          </li>
        </ul>
        {anyStuck && (
          <div className="mt-4 flex justify-center gap-2">
            {micStuck && (
              <button
                type="button"
                className="rounded-lg border border-paper-300 px-3 py-1.5 text-sm font-medium text-paper-800 hover:bg-paper-50"
                onClick={onOpenMicSettings}
              >
                打開系統設定
              </button>
            )}
            <button
              type="button"
              className="rounded-lg bg-paper-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-paper-800"
              onClick={onRestart}
            >
              重新開始
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const BARS = 7;
// Centre bars react most, edges least — reads as a voice waveform.
const BAR_GAIN = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45];

/**
 * The empty "listening" state: a live level waveform fed by `stt:level` (what
 * the engine actually receives), so speaking visibly registers before the
 * first words are recognized. Subscribes here so only this re-renders.
 */
export function ListeningIndicator({ title, note }: { title?: string; note?: string }) {
  const rms = useSttLevel(true) ?? 0;
  const level = rmsToLevel(rms);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-paper-600" role="status" aria-live="polite">
      <div className="flex h-10 items-center gap-1.5" aria-hidden="true">
        {BAR_GAIN.slice(0, BARS).map((g, i) => (
          <span
            key={i}
            className="ai-bar w-1.5 rounded-full transition-[height] duration-200 ease-out"
            style={{ height: `${Math.round(6 + 34 * Math.min(1, level * g))}px` }}
          />
        ))}
      </div>
      <p className="text-sm font-medium text-paper-700">{title ?? "聆聽中…請開始說話"}</p>
      <p className="text-xs text-paper-500">{note ?? "音量條會隨你的聲音跳動；說完一句，文字就會出現在這裡"}</p>
    </div>
  );
}
