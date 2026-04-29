import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Config } from "@/lib/types";

type Step = "intro" | "keys";

export default function WelcomeWizard({
  initialConfig,
  onDone,
}: {
  initialConfig: Config;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("intro");
  const [anthropic, setAnthropic] = useState(initialConfig.api.anthropic_api_key);
  const [deepgram, setDeepgram] = useState(initialConfig.api.deepgram_api_key);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showDeepgram, setShowDeepgram] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFinish() {
    setSaving(true);
    setError(null);
    try {
      const next: Config = {
        ...initialConfig,
        api: {
          ...initialConfig.api,
          anthropic_api_key: anthropic.trim(),
          deepgram_api_key: deepgram.trim(),
        },
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
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-stone-900/60 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        {step === "intro" ? (
          <>
            <h2 className="text-2xl font-semibold text-stone-900">歡迎使用 MeetingCast</h2>
            <p className="mt-2 text-sm text-stone-600">即時會議翻譯助手</p>

            <div className="mt-5 space-y-3 text-sm text-stone-700">
              <p>會議中你說中文，MeetingCast 會：</p>
              <ul className="ml-1 space-y-1.5">
                <li>🎙 即時辨識成中文逐字稿</li>
                <li>🌐 並行翻譯成英文與越南文，分別顯示在兩個獨立視窗</li>
                <li>📺 譯文視窗可拖到外接螢幕，給外籍同仁閱讀</li>
              </ul>
              <p className="text-xs text-stone-500">
                第一次啟動需要設定 API 金鑰，下一步開始。
              </p>
            </div>

            <footer className="mt-6 flex justify-end">
              <button
                className="rounded bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                onClick={() => setStep("keys")}
              >
                下一步
              </button>
            </footer>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-stone-900">設定 API 金鑰</h2>
            <p className="mt-1 text-sm text-stone-500">完成後即可開始錄音</p>

            <div className="mt-5 space-y-4 text-sm">
              <div>
                <label className="mb-1 flex items-center justify-between text-xs font-medium text-stone-700">
                  <span>
                    Anthropic API key <span className="text-rose-500">*</span>
                  </span>
                  <a
                    className="text-xs text-emerald-700 hover:underline"
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
                    className="flex-1 rounded border border-stone-300 px-2 py-1.5 font-mono text-xs"
                    value={anthropic}
                    onChange={(e) => setAnthropic(e.target.value)}
                    placeholder="sk-ant-api03-..."
                    autoFocus
                  />
                  <button
                    className="rounded border border-stone-300 px-2 text-xs text-stone-600 hover:bg-stone-50"
                    onClick={() => setShowAnthropic(!showAnthropic)}
                    type="button"
                  >
                    {showAnthropic ? "隱藏" : "顯示"}
                  </button>
                </div>
                <p className="mt-1 text-xs text-stone-400">用來呼叫 Claude 翻譯（必填）</p>
              </div>

              <div>
                <label className="mb-1 flex items-center justify-between text-xs font-medium text-stone-700">
                  <span>Deepgram API key（可略過）</span>
                  <a
                    className="text-xs text-stone-500 hover:underline"
                    href="https://console.deepgram.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    取得金鑰 ↗
                  </a>
                </label>
                <div className="flex gap-2">
                  <input
                    type={showDeepgram ? "text" : "password"}
                    className="flex-1 rounded border border-stone-300 px-2 py-1.5 font-mono text-xs"
                    value={deepgram}
                    onChange={(e) => setDeepgram(e.target.value)}
                    placeholder="（留空也可，預設用本地 mlx-whisper）"
                  />
                  <button
                    className="rounded border border-stone-300 px-2 text-xs text-stone-600 hover:bg-stone-50"
                    onClick={() => setShowDeepgram(!showDeepgram)}
                    type="button"
                  >
                    {showDeepgram ? "隱藏" : "顯示"}
                  </button>
                </div>
                <p className="mt-1 text-xs text-stone-400">
                  只在你想切到 cloud STT 時才需要；之後可在「設定」補
                </p>
              </div>

              {error && (
                <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
              )}
            </div>

            <footer className="mt-6 flex justify-between">
              <button
                className="rounded px-3 py-2 text-sm text-stone-500 hover:bg-stone-100"
                onClick={() => setStep("intro")}
                type="button"
              >
                ← 上一步
              </button>
              <button
                className="rounded bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-stone-300"
                onClick={handleFinish}
                disabled={!anthropic.trim() || saving}
                type="button"
              >
                {saving ? "儲存中…" : "完成"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
