const KEY = "meetingcast.sessionPanelCollapsed";

export function readSessionPanelCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function saveSessionPanelCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(KEY, String(collapsed));
  } catch {
    // Storage may be unavailable; the in-memory toggle still works.
  }
}
