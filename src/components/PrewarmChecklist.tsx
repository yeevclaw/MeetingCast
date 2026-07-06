import { friendly } from "@/lib/errors";

export type StepStatus = "pending" | "in_progress" | "done" | "error";
export type StepId = "spawn" | "model" | "mic";

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
}: {
  stepStatus: Record<StepId, StepStatus>;
  stepError: Partial<Record<StepId, string>>;
  // Live byte counters for the model-download step. Present only while a
  // first-run download is in flight; a cache hit never sets it.
  modelProgress?: { downloaded: number; total: number } | null;
}) {
  return (
    <ul className="space-y-2.5">
      {PREWARM_STEPS.map((s) => {
        const status = stepStatus[s.id];
        const err = stepError[s.id];
        return (
          <li key={s.id} className="flex items-start gap-3 text-sm">
            <StepIcon status={status} />
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
              {s.id === "model" && status === "in_progress" && modelProgress && (
                <p className="mt-0.5 text-[11px] text-paper-500">
                  已下載 {Math.round(modelProgress.downloaded / 1e6)} MB / 約{" "}
                  {(modelProgress.total / 1e9).toFixed(1)} GB
                </p>
              )}
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

function StepIcon({ status }: { status: StepStatus }) {
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
