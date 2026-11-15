"use client";

import { FinancialSnapshotPayloadSchema } from "@finn/shared";
import { useState } from "react";
import type { z } from "zod";
import { CountUp } from "@/components/ui/count-up";
import { cn } from "@/lib/cn";
import { formatInr, formatPlainPct } from "@/lib/format";
import { BarChart, LineChart } from "./charts";
import { ClaimLine } from "./claim";

type Snapshot = z.output<typeof FinancialSnapshotPayloadSchema>;

function formatByUnit(unit: string) {
  return (v: number | null) => {
    if (v == null) return "—";
    if (unit === "inr_crore") return formatInr(v * 1e7, { compact: true });
    if (unit === "inr") return formatInr(v, { compact: true });
    if (unit === "pct") return formatPlainPct(v);
    if (unit === "x") return `${v.toFixed(1)}×`;
    return v.toLocaleString("en-IN", { maximumFractionDigits: 1 });
  };
}

function isSecondary(source: string) {
  return /screener/i.test(source);
}

export function FinancialSnapshot({ data, symbol }: { data: Snapshot; symbol: string }) {
  const [active, setActive] = useState(data.series[0]?.key ?? "");
  const series = data.series.find((s) => s.key === active) ?? data.series[0];
  const sharedSource = data.headline.length > 0 && data.headline.every((h) => h.source === data.headline[0]!.source) ? data.headline[0]!.source : null;

  return (
    <div className="space-y-8">
      <div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-rule bg-rule">
          {data.headline.map((h) => (
            <div key={h.label} className="min-w-0 bg-paper px-3.5 py-3.5 xs:px-4 xs:py-4">
              <dt className="kicker text-ink-faint">{h.label}</dt>
              <dd className="mt-1.5 font-mono text-[20px] leading-none text-ink tnum xs:text-[22px]">
                <CountUp value={h.value} format={formatByUnit(h.unit)} id={`${symbol}-fin-${h.label}`} />
              </dd>
              <dd className={cn("mt-2 font-mono text-[10.5px]", isSecondary(h.source) ? "text-amber/80" : "text-ink-faint")}>
                {sharedSource ? h.period : `${h.period} · ${h.source}`}
              </dd>
            </div>
          ))}
        </dl>
        {sharedSource ? (
          <p className={cn("mt-2.5 font-mono text-[10.5px]", isSecondary(sharedSource) ? "text-amber/80" : "text-ink-faint")}>Source: {sharedSource}</p>
        ) : null}
      </div>

      {series ? (
        <div>
          <div className="scrollbar-none -mx-5 flex gap-1.5 overflow-x-auto px-5" role="tablist" aria-label="Financial series">
            {data.series.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={s.key === series.key}
                onClick={() => setActive(s.key)}
                className={cn(
                  "min-h-9 shrink-0 rounded-full border px-3 text-[12.5px] transition-colors",
                  s.key === series.key ? "border-ink bg-ink text-paper" : "border-rule-strong text-ink-muted hover:text-ink",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="mt-5" role="tabpanel" aria-label={series.label}>
            {series.unit === "pct" ? (
              <LineChart key={series.key} points={series.points} format={(v) => formatPlainPct(v)} label={`${series.label} by period`} />
            ) : (
              <BarChart key={series.key} points={series.points} format={(v) => formatByUnit(series.unit)(v)} label={`${series.label} by period`} />
            )}
          </div>
          <p className={cn("mt-3 font-mono text-[10.5px]", isSecondary(series.source) ? "text-amber/80" : "text-ink-faint")}>
            Source: {series.source}
            {isSecondary(series.source) ? " — standardised from company filings; used for multi-year trajectory only, never for a claim." : " — exchange filing."}
          </p>
        </div>
      ) : null}

      {data.takeaways.length ? (
        <ul className="space-y-3 border-t border-rule pt-5 text-[15px]">
          {data.takeaways.map((c) => (
            <ClaimLine key={c.text} claim={c} as="li" />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
