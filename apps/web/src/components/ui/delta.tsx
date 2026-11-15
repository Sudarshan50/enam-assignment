import { formatBps, formatSignedPct } from "@/lib/format";
import { cn } from "@/lib/cn";

/** A signed change, coloured only by direction; never neon. */
export function Delta({
  value,
  unit = "pct",
  digits = 1,
  className,
  arrow = true,
}: {
  value: number | null | undefined;
  unit?: "pct" | "bps";
  digits?: number;
  className?: string;
  arrow?: boolean;
}) {
  if (value == null || !Number.isFinite(value)) return <span className={cn("font-mono text-ink-faint", className)}>—</span>;
  const tone = value > 0.0001 ? "text-pos" : value < -0.0001 ? "text-neg" : "text-ink-muted";
  const glyph = value > 0.0001 ? "▲" : value < -0.0001 ? "▼" : "";
  const label = unit === "bps" ? formatBps(value) : formatSignedPct(value, digits);
  return (
    <span className={cn("inline-flex items-baseline gap-1 font-mono tnum whitespace-nowrap", tone, className)}>
      {arrow && glyph ? (
        <span aria-hidden className="text-[0.62em] leading-none">
          {glyph}
        </span>
      ) : null}
      <span>{label}</span>
    </span>
  );
}
