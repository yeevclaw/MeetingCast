import { friendly } from "@/lib/errors";

export type StepStatus = "pending" | "in_progress" | "done" | "error";
export type StepId = "spawn" | "model" | "mic";

// Live stats for the model-download step. `downloaded`/`total` come straight
// off the sidecar's progress events; speed/ETA/stalled are derived by the
// ControlWindow listener from consecutive samples (the sidecar only sends
// byte counters).
export type ModelProgress = {
  downloaded: number;
  total: number;
  speedBps?: number | null;
  etaSec?: number | null;
  stalled?: boolean;
};

// "就緒" is intentionally not a row — when the ready event fires, the
// overlay dismisses and the user moves on, so a row that never visibly
// ticks would just look stuck. Three concrete steps is clearer.
export const PREWARM_STEPS: Array<{ id: StepId; label: string }> = [
  { id: "spawn", label: "啟動辨識子程序" },
  { id: "model", label: "載入語音模型" },
  { id: "mic", label: "初始化麥克風" },
];

/**
 * The 3-row startup checklist (spawn / model / mic) shared between the
 * ControlWindow prewarm overlay and the Welcome wizard's final step.
 */
export default function PrewarmChecklist({
  stepStatus,
  stepError,
  modelProgress,
  modelCached,
}: {
  stepStatus: Record<StepId, StepStatus>;
  stepError: Partial<Record<StepId, string>>;
  // Present only while a first-run download is in flight; a cache hit never
  // sets it.
  modelProgress?: ModelProgress | null;
  // True while a cache-hit model load runs (weights already local, no
  // download) — shows a "已在本機" hint instead of a bare spinner.
  modelCached?: boolean;
}) {
  return (
    <ul className="space-y-2.5">
      {PREWARM_STEPS.map((s) => {
        const status = stepStatus[s.id];
        const err = stepError[s.id];
        const stalled =
          s.id === "model" &&
          status === "in_progress" &&
          !!modelProgress?.stalled;
        return (
          <li key={s.id} className="flex items-start gap-3 text-sm">
            <StepIcon status={status} stalled={stalled} />
            <div className="flex-1">
              <p
                className={
                  status === "done"
                    ? "text-paper-500 line-through decoration-paper-400"
                    : status === "in_progress"
                      ? "font-medium text-paper-900"
                      : status === "error"
                        ? "font-medium text-danger-700"
                        : "text-paper-500"
                }
              >
                {s.label}
              </p>
              {s.id === "model" &&
                status === "in_progress" &&
                (modelProgress ? (
                  <ModelProgressDetail progress={modelProgress} />
                ) : modelCached ? (
                  <p className="mt-1 text-[11px] text-paper-500">
                    模型已在本機，載入到記憶體中…
                  </p>
                ) : null)}
              {err && status === "error" && (() => {
                const f = friendly(err);
                return (
                  <>
                    <p className="mt-0.5 break-all text-[11px] text-danger-700">
                      {f.primary}
                    </p>
                    {f.secondary && (
                      <p className="mt-0.5 break-all text-[11px] text-danger-700">
                        {f.secondary}
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ModelProgressDetail({ progress }: { progress: ModelProgress }) {
  const { downloaded, total, speedBps, etaSec, stalled } = progress;
  // The sidecar clamps its own reporting at 99% too — 100% only ever comes
  // from the step's "done" event, which clears this whole block.
  const pct = Math.min(99, Math.round((downloaded / total) * 100));
  const parts = [
    `${Math.round(downloaded / 1e6)} MB / ${(total / 1e9).toFixed(1)} GB`,
  ];
  if (!stalled) {
    if (speedBps != null && speedBps > 0) parts.push(formatSpeed(speedBps));
    if (etaSec != null && Number.isFinite(etaSec)) parts.push(formatEta(etaSec));
  }
  return (
    <>
      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-200">
          <div
            className={`h-full rounded-full transition-[width] duration-700 ${
              stalled ? "bg-warn-700" : "bg-paper-700"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-7 text-right text-[11px] tabular-nums text-paper-600">
          {pct}%
        </span>
      </div>
      <p className="mt-1 text-[11px] text-paper-500">
        {parts.join(" · ")}
        {stalled && (
          <span className="text-warn-700"> · 下載停滯，請檢查網路連線</span>
        )}
      </p>
    </>
  );
}

function formatSpeed(bps: number): string {
  return bps >= 1e6
    ? `${(bps / 1e6).toFixed(1)} MB/s`
    : `${Math.round(bps / 1e3)} KB/s`;
}

function formatEta(sec: number): string {
  // Below 90s, round to 5s steps so the countdown doesn't jitter.
  return sec >= 90
    ? `剩約 ${Math.round(sec / 60)} 分`
    : `剩約 ${Math.max(5, Math.round(sec / 5) * 5)} 秒`;
}

function StepIcon({ status, stalled }: { status: StepStatus; stalled?: boolean }) {
  if (status === "done") {
    return (
      <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-paper-700 text-white">
        <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5 L6.5 12 L13 4.5" />
        </svg>
      </span>
    );
  }
  if (status === "in_progress") {
    if (stalled) {
      return (
        <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-warn-700">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </span>
      );
    }
    return (
      <span className="mt-0.5 inline-block h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-paper-200 border-t-paper-900" />
    );
  }
  if (status === "error") {
    return (
      <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-danger-700 text-[10px] font-bold text-white">
        ×
      </span>
    );
  }
  return (
    <span className="mt-0.5 inline-block h-4 w-4 flex-shrink-0 rounded-full border-2 border-paper-300" />
  );
}
