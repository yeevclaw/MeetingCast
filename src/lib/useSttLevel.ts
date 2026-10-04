import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Live input RMS the sidecar reports via `stt:level` (~4 Hz) while `active`.
 * Subscribe from the small component that draws the meter — not from a big
 * parent window — so only that component re-renders on every sample.
 * Returns null while inactive, 0 until the first sample arrives.
 */
export function useSttLevel(active: boolean): number | null {
  const [level, setLevel] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setLevel(null);
      return;
    }
    setLevel(0);
    let disposed = false;
    const un = listen<number>("stt:level", (e) => {
      if (!disposed) setLevel(Number(e.payload) || 0);
    });
    return () => {
      disposed = true;
      un.then((u) => u());
    };
  }, [active]);
  return level;
}

/**
 * Latches true the first time an `stt:level` sample above `threshold` arrives
 * while `active`. Stays true until `reset()`; while latched it unsubscribes,
 * so the host re-renders at most once per latch.
 */
export function useSttHeardLatch(active: boolean, threshold: number): [boolean, () => void] {
  const [heard, setHeard] = useState(false);
  useEffect(() => {
    if (!active || heard) return;
    let disposed = false;
    const un = listen<number>("stt:level", (e) => {
      if (!disposed && (Number(e.payload) || 0) > threshold) setHeard(true);
    });
    return () => {
      disposed = true;
      un.then((u) => u());
    };
  }, [active, heard, threshold]);
  const reset = useCallback(() => setHeard(false), []);
  return [heard, reset];
}
