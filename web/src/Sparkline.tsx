// Tiny inline SVG sparklines — no deps.
//  - Sparkline: latency trend; down samples are drawn as red dots at the baseline.
//  - NumberSpark: a plain numeric series (used for the monthly cost trend).
import type { HealthSample } from "./api";

export function NumberSpark({
  values,
  width = 120,
  height = 26,
  stroke = "var(--degraded)",
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
}) {
  if (values.length === 0) return <span className="muted">—</span>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} className="spark" aria-hidden>
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" />
      {n === 1 && <circle cx={x(0)} cy={y(values[0])} r={2} fill={stroke} />}
    </svg>
  );
}

export function Sparkline({ samples, width = 120, height = 26 }: { samples: HealthSample[]; width?: number; height?: number }) {
  if (samples.length === 0) return <span className="muted">—</span>;
  // API returns newest-first; draw left→right oldest→newest.
  const pts = [...samples].reverse();
  const lat = pts.map((s) => (s.status === "down" ? 0 : s.latency_ms));
  const max = Math.max(...lat, 1);
  const n = pts.length;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => height - 2 - (v / max) * (height - 4);
  const line = pts.map((_, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(lat[i]).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} className="spark" aria-hidden>
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      {pts.map((s, i) =>
        s.status === "down" ? <circle key={i} cx={x(i)} cy={height - 2} r={2} fill="var(--down)" /> : null,
      )}
    </svg>
  );
}
