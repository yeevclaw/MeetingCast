import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Labels of the two translation-slot windows (see tauri.conf.json). */
export type SlotLabel = "t1" | "t2";
export const SLOT_LABELS: SlotLabel[] = ["t1", "t2"];

// Default geometry, mirrors tauri.conf.json so a re-created window lands
// where a fresh launch would put it.
const SLOT_GEOMETRY: Record<SlotLabel, { x: number; y: number }> = {
  t1: { x: 540, y: 80 },
  t2: { x: 540, y: 440 },
};

export function slotLabel(slotIndex: 0 | 1): SlotLabel {
  return slotIndex === 0 ? "t1" : "t2";
}

/** True when the window exists (the user hasn't closed it). */
export async function isSlotWindowOpen(label: SlotLabel): Promise<boolean> {
  return (await WebviewWindow.getByLabel(label)) !== null;
}

/** Bring an existing slot window to the front, or re-create it if the user
 *  closed it. Re-creation needs `core:webview:allow-create-webview-window`
 *  (capabilities/default.json). The new window boots main.tsx, which routes
 *  by label, so it resolves its language from config like the original. */
export async function openSlotWindow(label: SlotLabel): Promise<void> {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.show().catch(() => {});
    await existing.unminimize().catch(() => {});
    await existing.setFocus().catch(() => {});
    return;
  }
  const geo = SLOT_GEOMETRY[label];
  const w = new WebviewWindow(label, {
    title: "譯文視窗",
    width: 900,
    height: 320,
    x: geo.x,
    y: geo.y,
  });
  await new Promise<void>((resolve, reject) => {
    w.once("tauri://created", () => resolve());
    w.once("tauri://error", (e) => reject(e.payload));
  });
}
