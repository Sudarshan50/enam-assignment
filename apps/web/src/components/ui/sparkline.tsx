import { useId } from "react";
import { cn } from "@/lib/cn";

/** A 30-session price line. Colour follows the period's direction; a dot marks the last close. */
/** `className` may set a narrower CSS width; the line stretches to fit and keeps its stroke weight. */
export function Sparkline({ values, width = 84, height = 28, label, className }: { values: number[]; width?: number; height?: number; label: string; className?: string }) {
  const gid = useId();
  if (values.length < 2) return <span className={cn("inline-block", className)} style={{ width: className ? undefined : width, height }} aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = values[values.length - 1]! >= values[0]!;
  const color = up ? "var(--color-pos)" : "var(--color-neg)";
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]!);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn("overflow-visible", className)}
    >
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${lastX.toFixed(1)},${height} L${pad},${height} Z`} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  );
}
