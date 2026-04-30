import { useEffect, useRef, useState } from "react";

const SEGMENTS = 10;

export default function MicMeter({
  active,
  deviceLabel,
}: {
  active: boolean;
  deviceLabel?: string;
}) {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let buf: Uint8Array | null = null;

    function tick() {
      if (cancelled || !analyser || !buf) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // Normal speech RMS sits ~0.05–0.2 — scale ×5 so a moderate voice
      // lights 3 of 4 bars without clipping immediately.
      setLevel(Math.min(1, rms * 5));
      rafRef.current = requestAnimationFrame(tick);
    }

    (async () => {
      try {
        // If a specific device was chosen in Settings, find its Web Audio
        // deviceId by matching label. Labels are populated only after the
        // app has called getUserMedia at least once (ControlWindow does
        // this on mount), so by the time the meter activates they should
        // be available. Falls back to system default if not found.
        let constraints: MediaStreamConstraints = { audio: true };
        if (deviceLabel) {
          try {
            const list = await navigator.mediaDevices.enumerateDevices();
            const target = list.find(
              (d) => d.kind === "audioinput" && d.label === deviceLabel,
            );
            if (target?.deviceId) {
              constraints = { audio: { deviceId: { exact: target.deviceId } } };
            }
          } catch {
            // Ignore — fall through to default constraints.
          }
        }
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        buf = new Uint8Array(analyser.fftSize);
        tick();
      } catch {
        // permission denied / no mic — leave bars dim
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [active, deviceLabel]);

  const litCount = Math.round(level * SEGMENTS);

  return (
    <span className="inline-flex items-center gap-px" aria-label="麥克風音量">
      {Array.from({ length: SEGMENTS }).map((_, i) => (
        <span
          key={i}
          className={`block h-2 w-0.5 rounded-sm transition-colors duration-75 ${
            i < litCount ? "bg-paper-900" : "bg-paper-300"
          }`}
        />
      ))}
    </span>
  );
}
