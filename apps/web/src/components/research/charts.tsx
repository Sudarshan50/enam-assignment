"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

export interface Point {
  period: string;
  value: number | null;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

const PAD = { top: 26, right: 4, bottom: 24, left: 4 };

/** Bars with the latest period emphasised; values labelled at the first and last bar only. */
export function BarChart({ points, format, height = 190, label }: { points: Point[]; format: (v: number) => string; height?: number; label: string }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const values = points.map((p) => p.value ?? 0);
  const max = Math.max(...values, 0) || 1;
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const slot = points.length ? innerW / points.length : 0;
  const barW = Math.min(44, slot * 0.62);

  return (
    <div ref={ref} className="w-full">
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
          {[0.5, 1].map((f) => (
            <line key={f} x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH * (1 - f)} y2={PAD.top + innerH * (1 - f)} stroke="var(--color-rule)" />
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke="var(--color-rule-strong)" />
          {points.map((p, i) => {
            const v = p.value ?? 0;
            const h = (v / max) * innerH;
            const x = PAD.left + slot * i + (slot - barW) / 2;
            const last = i === points.length - 1;
            const labelled = last || i === 0;
            return (
              <g key={p.period}>
                <motion.rect
                  x={x}
                  width={barW}
                  rx={2}
                  initial={{ height: 0, y: PAD.top + innerH }}
                  animate={{ height: h, y: PAD.top + innerH - h }}
                  transition={{ duration: 0.7, delay: i * 0.05, ease: [0.2, 0.7, 0.2, 1] }}
                  fill={last ? "var(--color-ink)" : "rgb(236 230 218 / 0.22)"}
                />
                {p.value == null ? (
                  <text x={x + barW / 2} y={PAD.top + innerH - 6} textAnchor="middle" className="fill-ink-faint font-mono text-[10px]">
                    n/a
                  </text>
                ) : null}
                {labelled && p.value != null ? (
                  <text x={x + barW / 2} y={PAD.top + innerH - h - 8} textAnchor="middle" className={`font-mono text-[10.5px] ${last ? "fill-ink" : "fill-ink-faint"}`}>
                    {format(p.value)}
                  </text>
                ) : null}
                <text x={x + barW / 2} y={height - 6} textAnchor="middle" className={`font-mono text-[10px] ${last ? "fill-ink-muted" : "fill-ink-faint"}`}>
                  {p.period}
                </text>
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
}

/** A single series line with dots; first and last values labelled. */
export function LineChart({ points, format, height = 190, label }: { points: Point[]; format: (v: number) => string; height?: number; label: string }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const defined = points.filter((p): p is { period: string; value: number } => p.value != null);
  const vals = defined.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const min = lo - span * 0.35;
  const max = hi + span * 0.25;
  const innerW = Math.max(0, width - PAD.left - PAD.right - 24);
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + 12 + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW / 2);
  const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * innerH;
  const d = points
    .map((p, i) => (p.value == null ? null : `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`))
    .filter(Boolean)
    .map((c, i) => `${i === 0 ? "M" : "L"}${c}`)
    .join(" ");

  return (
    <div ref={ref} className="w-full">
      {width > 0 && defined.length > 0 ? (
        <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH * f} y2={PAD.top + innerH * f} stroke={f === 1 ? "var(--color-rule-strong)" : "var(--color-rule)"} />
          ))}
          <motion.path
            d={d}
            fill="none"
            stroke="var(--color-amber)"
            strokeWidth={1.75}
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1, ease: [0.2, 0.7, 0.2, 1] }}
          />
          {points.map((p, i) => {
            if (p.value == null) return null;
            const last = i === points.length - 1;
            const labelled = last || i === 0 || p.value === hi;
            return (
              <g key={p.period}>
                <circle cx={x(i)} cy={y(p.value)} r={last ? 3.5 : 2.25} fill={last ? "var(--color-amber)" : "var(--color-paper)"} stroke="var(--color-amber)" strokeWidth={1.25} />
                {labelled ? (
                  <text x={x(i)} y={y(p.value) - 10} textAnchor="middle" className={`font-mono text-[10.5px] ${last ? "fill-ink" : "fill-ink-faint"}`}>
                    {format(p.value)}
                  </text>
                ) : null}
                <text x={x(i)} y={height - 6} textAnchor="middle" className="fill-ink-faint font-mono text-[10px]">
                  {p.period}
                </text>
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
}
