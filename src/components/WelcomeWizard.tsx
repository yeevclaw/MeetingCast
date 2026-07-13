import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import PrewarmChecklist, {
  type ModelProgress,
  type StepId,
  type StepStatus,
} from "@/components/PrewarmChecklist";
import type { Config } from "@/lib/types";

type Step = "intro" | "keys" | "ready";

/** Tri-state result from the Rust validate_*_key commands. */
type KeyCheck = "valid" | "invalid" | "unknown";

function KeyCheckHint({ check }: { check: KeyCheck | null }) {
  if (check === "valid") {
    return <p className="mt-1 text-xs text-paper-700">✓ 金鑰有效</p>;
  }
  if (check === "invalid") {
    return (
      <p className="mt-1 text-xs text-danger-700">金鑰無效，請確認是否複製完整</p>
    );
  }
  if (check === "unknown") {
    return (
      <p className="mt-1 text-xs text-warn-700">
        ⚠ 暫時無法驗證（網路問題），先繼續也可以
      </p>
    );
  }
  return null;
}

export default function WelcomeWizard({
  initialConfig,
  onDone,
  stepStatus,
  stepError,
  modelProgress,
  modelCached,
  retryPrewarm,
  micAvailable,
}: {
  initialConfig: Config;
  onDone: () => void;
  stepStatus: Record<StepId, StepStatus>;
  stepError: Partial<Record<StepId, string>>;
  modelProgress?: ModelProgress | null;
  modelCached?: boolean;
  retryPrewarm: () => void;
  micAvailable: boolean | null;
}) {
  const [step, setStep] = useState<Step>("intro");
  const [anthropic, setAnthropic] = useState(initialConfig.api.anthropic_api_key);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [anthropicCheck, setAnthropicCheck] = useState<KeyCheck | null>(null);

  const hasPrewarmError = Object.values(stepStatus).some((s) => s === "error");
  const modelDone = stepStatus.model === "done";
  const hasInvalidKey = anthropicCheck === "invalid";

  async function handleKeysNext() {
    setValidating(true);
    try {
      const a = await invoke<KeyCheck>("validate_anthropic_key", { key: anthropic.trim() });
      setAnthropicCheck(a);
      // Only a confirmed-invalid key blocks; "unknown" (network trouble)
      // never does — the user shouldn't be locked out of their own app
      // because the wifi is flaky.
      if (a !== "invalid") {
        setStep("ready");
      }
    } catch {
      // The command itself failed — treat as unverifiable and let the user
      // through; start_stt still guards with a toast when the key is bad.
      setStep("ready");
    } finally {
      setValidating(false);
    }
  }

  async function handleFinish() {
    setSaving(true);
    setError(null);
    try {
      const next: Config = {
        ...initialConfig,
        api: {
          ...initialConfig.api,
          anthropic_api_key: anthropic.trim(),
        },
        onboarding_complete: true,
      };
      await invoke("set_config", { config: next });
      onDone();
    } catch (e) {
      setError(`儲存失敗: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-paper-900/50 p-4">
      <div className="w-full max-w-lg rounded-lg border border-paper-200 bg-white p-6 shadow-2xl">
        {step === "intro" ? (
          <>
            <h2 className="text-2xl font-semibold text-paper-900">歡迎使用 MeetingCast</h2>
            <p className="mt-2 text-sm text-paper-600">即時會議翻譯助手</p>

            <div className="mt-5 space-y-3 text-sm text-paper-700">
              <p>會議中你發言，MeetingCast 會：</p>
              <ul className="ml-1 space-y-1.5">
                <li>🎙 即時辨識成逐字稿（預設中文）</li>
                <li>🌐 並行翻譯成兩種語言（預設英文＋越南文，可在「設定 → 語言」變更）</li>
                <li>📺 譯文視窗可拖到外接螢幕，給外籍同仁閱讀</li>
              </ul>
              <div className="rounded-lg border border-paper-200 bg-paper-100 px-3 py-2.5">
                <p className="text-xs font-medium text-paper-700">接下來會發生什麼</p>
                <ul className="mt-1.5 space-y-1 text-xs text-paper-600">
                  <li>🪟 App 會開啟三個視窗：控制視窗＋兩個譯文視窗（可拖到外接螢幕）</li>
                  <li>🎤 macOS 會跳出麥克風授權對話框，請按「允許」</li>
                  <li>⬇️ 首次啟動會在背景下載語音模型（約 1.6 GB），下載期間可先完成設定</li>
                </ul>
              </div>
              <p className="text-xs text-paper-500">
                第一次啟動需要設定 API 金鑰，下一步開始。
              </p>
            </div>

            <footer className="mt-6 flex justify-end">
              <button
                className="rounded bg-paper-900 px-5 py-2 text-sm font-medium text-white hover:bg-paper-700"
                onClick={() => setStep("keys")}
              >
                下一步
              </button>
            </footer>
          </>
        ) : step === "keys" ? (
          <>
            <h2 className="text-xl font-semibold text-paper-900">設定 API 金鑰</h2>
            <p className="mt-1 text-sm text-paper-600">完成後即可開始錄音</p>

            <div className="mt-5 space-y-4 text-sm">
              <div>
                <label className="mb-1 flex items-center justify-between text-xs font-medium text-paper-700">
                  <span>
                    Anthropic API key <span className="text-danger-700">*</span>
                  </span>
                  <a
                    className="text-xs text-paper-900 hover:underline"
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                  >
                    取得金鑰 ↗
                  </a>
                </label>
                <div className="flex gap-2">
                  <input
                    type={showAnthropic ? "text" : "password"}
                    className="flex-1 rounded border border-paper-300 px-2 py-1.5 font-mono text-xs"
                    value={anthropic}
                    onChange={(e) => {
                      setAnthropic(e.target.value);
                      setAnthropicCheck(null);
                    }}
                    placeholder="sk-ant-api03-..."
                    autoFocus
                  />
                  <button
                    className="rounded border border-paper-300 px-2 text-xs text-paper-700 hover:bg-paper-100"
                    onClick={() => setShowAnthropic(!showAnthropic)}
                    type="button"
                  >
                    {showAnthropic ? "隱藏" : "顯示"}
                  </button>
                </div>
                <p className="mt-1 text-xs text-paper-500">用來呼叫 Claude 翻譯（必填）</p>
                <KeyCheckHint check={anthropicCheck} />
              </div>
            </div>

            <footer className="mt-6 flex items-center justify-between">
              <button
                className="rounded px-3 py-2 text-sm text-paper-600 hover:bg-paper-100"
                onClick={() => setStep("intro")}
                type="button"
              >
                ← 上一步
              </button>
              <div className="flex items-center gap-3">
                <button
                  className="text-xs text-paper-500 underline-offset-2 hover:text-paper-700 hover:underline"
                  onClick={() => setStep("ready")}
                  type="button"
                >
                  略過，稍後在設定填
                </button>
                {hasInvalidKey && (
                  <button
                    className="text-xs text-danger-700 underline-offset-2 hover:underline"
                    onClick={() => setStep("ready")}
                    type="button"
                  >
                    仍要繼續
                  </button>
                )}
                <button
                  className="rounded bg-paper-900 px-5 py-2 text-sm font-medium text-white hover:bg-paper-700 disabled:bg-paper-400"
                  onClick={handleKeysNext}
                  disabled={!anthropic.trim() || validating}
                  type="button"
                >
                  {validating ? "驗證中…" : "下一步"}
                </button>
              </div>
            </footer>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-paper-900">正在準備辨識引擎</h2>
            <p className="mt-1 text-sm text-paper-600">
              下方步驟會自動完成，不需等待也可以先按完成
            </p>

            <div className="mt-5">
              <PrewarmChecklist
                stepStatus={stepStatus}
                stepError={stepError}
                modelProgress={modelProgress}
                modelCached={modelCached}
              />
            </div>

            {hasPrewarmError && (
              <div className="mt-4 flex flex-col items-center gap-2">
                <button
                  className="rounded border border-paper-300 px-4 py-1.5 text-sm text-paper-700 hover:bg-paper-100"
                  onClick={retryPrewarm}
                  type="button"
                >
                  重試
                </button>
                <p className="text-center text-[11px] text-paper-500">
                  首次啟動需下載 ~1.6 GB；網路不穩可重試
                </p>
              </div>
            )}

            {micAvailable === false && (
              <p className="mt-4 rounded border border-warn-200 bg-warn-50 px-3 py-2 text-xs text-warn-900">
                ⚠️ 麥克風尚未授權 — 完成後請依主畫面指示開啟系統設定
              </p>
            )}

            {error && (
              <p className="mt-4 rounded bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</p>
            )}

            <footer className="mt-6 flex justify-between">
              <button
                className="rounded px-3 py-2 text-sm text-paper-600 hover:bg-paper-100"
                onClick={() => setStep("keys")}
                type="button"
              >
                ← 上一步
              </button>
              <button
                className="rounded bg-paper-900 px-5 py-2 text-sm font-medium text-white hover:bg-paper-700 disabled:bg-paper-400"
                onClick={handleFinish}
                disabled={saving}
                type="button"
              >
                {saving
                  ? "儲存中…"
                  : modelDone
                    ? "完成"
                    : "完成（模型會在背景繼續下載）"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
