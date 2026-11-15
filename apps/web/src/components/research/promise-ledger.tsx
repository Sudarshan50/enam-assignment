"use client";

import { PromiseLedgerPayloadSchema, type GuidanceMetric, type PromiseItem, type Verdict } from "@finn/shared";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { z } from "zod";
import { Badge, type Tone } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { CitationChips } from "./claim";

type Ledger = z.output<typeof PromiseLedgerPayloadSchema>;

const METRIC_LABEL: Record<GuidanceMetric, string> = {
  revenue_growth: "Revenue growth",
  ebitda_margin: "Operating margin",
  pat_growth: "PAT growth",
  capex: "Capex",
  order_book: "Order book",
  volume_growth: "Volume growth",
  net_debt: "Net debt",
};

export const VERDICT: Record<Verdict, { label: string; tone: Tone; color: string }> = {
  delivered: { label: "Delivered", tone: "pos", color: "var(--color-pos)" },
  missed: { label: "Missed", tone: "neg", color: "var(--color-neg)" },
  quietly_dropped: { label: "Quietly dropped", tone: "amber", color: "var(--color-amber)" },
  pending: { label: "Pending", tone: "know", color: "var(--color-know)" },
  not_scored: { label: "Not scored", tone: "noise", color: "var(--color-noise)" },
};

const TALLY_ORDER: Verdict[] = ["delivered", "missed", "quietly_dropped", "pending"];

function fmt(value: number, unit: PromiseItem["unit"]): string {
  const n = value.toLocaleString("en-IN", { maximumFractionDigits: 1 });
  return unit === "pct" ? `${n}%` : unit === "inr_crore" ? `₹${n} Cr` : `${n}×`;
}

function guided(p: PromiseItem): string {
  const { low, high, unit } = p;
  if (low == null && high == null) return "No number";
  if (low != null && high != null) {
    if (low === high) return `~${fmt(low, unit)}`;
    const lo = low.toLocaleString("en-IN", { maximumFractionDigits: 1 });
    return unit === "pct" ? `${lo}–${fmt(high, unit)}` : unit === "inr_crore" ? `₹${lo}–${high.toLocaleString("en-IN")} Cr` : `${lo}–${fmt(high, unit)}`;
  }
  return low != null ? `≥ ${fmt(low, unit)}` : `≤ ${fmt(high!, unit)}`;
}

/** Guided band (or floor) with the filed actual marked on it. */
function RangeBar({ p }: { p: PromiseItem }) {
  if (p.low == null && p.high == null) return null;
  const tolerance = p.low != null && p.high != null && p.low === p.high ? 0.1 : 0;
  const lo = (p.low ?? p.high!) * (1 - tolerance);
  const hi = p.high != null ? p.high * (1 + tolerance) : null;
  const values = [lo, hi ?? lo * 1.6, p.actual ?? lo].filter((v): v is number => v != null);
  const min = Math.min(...values) * 0.75;
  const max = Math.max(...values) * 1.12;
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  const color = VERDICT[p.verdict].color;
  return (
    <div className="relative mt-4 h-6" aria-hidden>
      <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-rule-strong" />
      <div
        className="absolute top-1/2 h-2 -translate-y-1/2 border-l border-ink-faint"
        style={{
          left: pos(lo),
          width: hi != null ? `calc(${pos(hi)} - ${pos(lo)})` : `calc(100% - ${pos(lo)})`,
          background: hi != null ? "rgb(236 230 218 / 0.2)" : "linear-gradient(90deg, rgb(236 230 218 / 0.22), transparent)",
          borderRightWidth: hi != null ? 1 : 0,
          borderRightColor: "var(--color-ink-faint)",
        }}
      />
      {p.actual != null ? (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 22, delay: 0.15 }}
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-paper"
          style={{ left: pos(p.actual), background: color }}
        />
      ) : null}
    </div>
  );
}

function PromiseRow({ p }: { p: PromiseItem }) {
  const v = VERDICT[p.verdict];
  const dropped = p.verdict === "quietly_dropped";
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35 }}
      className={cn("border-t border-rule py-6", dropped && "-mx-4 rounded-2xl border border-amber/25 bg-amber-soft px-4 sm:-mx-5 sm:px-5")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-medium text-ink">{METRIC_LABEL[p.metric]}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
            for {p.horizonLabel} · {p.statementType === "explicit_guidance" ? "explicit guidance" : p.statementType}
          </p>
        </div>
        <Badge tone={v.tone} className="shrink-0">
          {v.label}
        </Badge>
      </div>

      {p.verdict !== "not_scored" ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <p className="kicker text-ink-faint">Guided</p>
              <p className="mt-1 font-mono text-[18px] text-ink tnum">{guided(p)}</p>
            </div>
            <div>
              <p className="kicker text-ink-faint">{p.actualPeriod ? `Filed · ${p.actualPeriod}` : "Filed"}</p>
              <p className="mt-1 font-mono text-[18px] tnum" style={{ color: p.actual != null ? v.color : undefined }}>
                {p.actual != null ? fmt(p.actual, p.unit) : <span className="text-ink-faint">{dropped ? "—" : "open"}</span>}
              </p>
            </div>
          </div>
          <RangeBar p={p} />
        </>
      ) : null}

      <figure className="mt-4">
        <blockquote className="font-display text-[19px] leading-[1.38] text-ink italic">&ldquo;{p.quote}&rdquo;</blockquote>
        <figcaption className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-ink-faint">
          <span>
            {p.speaker ? `${p.speaker}, ` : ""}
            {p.saidIn}
          </span>
          <CitationChips citations={[p.citation]} claim={`${METRIC_LABEL[p.metric]} for ${p.horizonLabel}: ${guided(p)}`} />
        </figcaption>
      </figure>

      <p className={cn("mt-3 text-[13.5px] leading-relaxed", dropped ? "text-ink" : "text-ink-muted")}>{p.explanation}</p>
      {p.actualSource ? <p className="mt-1.5 font-mono text-[10.5px] text-ink-faint">Actual from {p.actualSource}</p> : null}
    </motion.li>
  );
}

type Filter = "all" | Verdict;

export function PromiseLedger({ ledger }: { ledger: Ledger }) {
  const [filter, setFilter] = useState<Filter>("all");
  const { summary, promises } = ledger;
  const scored = promises.filter((p) => p.verdict !== "not_scored");
  const tally = TALLY_ORDER.flatMap((verdict) => scored.filter((p) => p.verdict === verdict));
  const counts = (v: Verdict) => promises.filter((p) => p.verdict === v).length;
  const shown = filter === "all" ? promises : promises.filter((p) => p.verdict === filter);
  const filters: Array<{ value: Filter; label: string; n: number }> = [
    { value: "all", label: "All", n: promises.length },
    ...(["delivered", "missed", "quietly_dropped", "pending", "not_scored"] as Verdict[])
      .map((v) => ({ value: v as Filter, label: VERDICT[v].label, n: counts(v) }))
      .filter((f) => f.n > 0),
  ];

  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <p className="font-display text-[64px] leading-[0.9] tracking-[-0.02em] text-ink tnum sm:text-[76px]" aria-label={`Delivered ${summary.delivered} of ${summary.elapsed}`}>
          {summary.delivered}
          <span className="text-ink-faint"> of {summary.elapsed}</span>
        </p>
        <p className="pb-1.5 text-[15px] leading-snug text-ink-muted">
          promises delivered
          <br />
          whose deadline has passed
        </p>
      </div>

      <div className="mt-5 flex flex-wrap gap-1.5" role="img" aria-label={`${summary.delivered} delivered, ${summary.missed} missed, ${summary.quietlyDropped} quietly dropped, ${summary.pending} pending`}>
        {tally.map((p, i) => (
          <motion.span
            key={p.id}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.05 * i, type: "spring", stiffness: 400, damping: 24 }}
            className="size-[18px] rounded-[4px]"
            style={
              p.verdict === "pending"
                ? { border: `1.5px solid ${VERDICT.pending.color}` }
                : p.verdict === "quietly_dropped"
                  ? { background: `repeating-linear-gradient(135deg, ${VERDICT.quietly_dropped.color} 0 3px, transparent 3px 6px)`, border: `1px solid ${VERDICT.quietly_dropped.color}` }
                  : { background: VERDICT[p.verdict].color }
            }
          />
        ))}
      </div>
      <p className="mt-3 text-[13.5px] text-ink-muted">
        <span className="text-neg">{summary.missed} missed</span> · <span className="text-amber">{summary.quietlyDropped} quietly dropped</span> ·{" "}
        <span className="text-know">{summary.pending} still open</span>
      </p>
      <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-ink-faint">
        From {ledger.transcriptsUsed.length} calls ({ledger.transcriptsUsed[0]} – {ledger.transcriptsUsed.at(-1)}), matched to same-period filed actuals. A
        count with its denominator — never a score.
      </p>

      <div className="scrollbar-none -mx-5 mt-6 flex gap-1.5 overflow-x-auto px-5" role="toolbar" aria-label="Filter promises">
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "min-h-9 shrink-0 rounded-full border px-3 text-[12.5px] transition-colors",
              filter === f.value ? "border-ink bg-ink text-paper" : "border-rule-strong text-ink-muted hover:text-ink",
            )}
          >
            {f.label} <span className="font-mono text-[11px] opacity-70">{f.n}</span>
          </button>
        ))}
      </div>

      <ul className="mt-4 [&>li:first-child:not(.rounded-2xl)]:border-t-0">
        <AnimatePresence initial={false}>
          {shown.map((p) => (
            <PromiseRow key={p.id} p={p} />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
