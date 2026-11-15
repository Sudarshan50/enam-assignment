"use client";

import type { ReactNode } from "react";
import { sourceLabel } from "@/components/digest/digest-states";
import { PageColumns, PageTitle } from "@/components/layout/page";
import { CountUp } from "@/components/ui/count-up";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { formatCount, timeAgo } from "@/lib/format";
import { useEngine } from "@/lib/hooks/data";
import { useNow } from "@/lib/hooks/ui";
import { purposeLabel } from "@/lib/labels";
import { Pipeline, type Stage } from "./pipeline";

const PUSH: Stage[] = [
  { name: "Ingest", detail: "One market-wide NSE call per poll, filtered to your 18 and upserted on seq_id. A watermark with overlap self-heals gaps." },
  { name: "Classify", detail: "Rules on the subject first; GLM with a strict JSON schema only for what rules can't place, in batches of 10." },
  { name: "Score", detail: "Category weight × your weight × impact, clamped 0–100. Fraud or default is always Act." },
  { name: "Enrich", detail: "Results from the XBRL, people and deals from the PDF. Related filings collapse into one card." },
  { name: "Digest", detail: "Only ready cards, with source health — no 'caught up' unless every poll in the window succeeded." },
];

const PULL: Stage[] = [
  { name: "Documents", detail: "Annual reports and concall transcripts, fetched from an allowlist and checksummed." },
  { name: "Chunk", detail: "~500-token passages split at headings, page ranges kept, tables whole." },
  { name: "Embed", detail: "EmbeddingGemma-2 on Cloudflare Workers AI, 768 dimensions, task-prefixed." },
  { name: "Retrieve", detail: "Full-text and vector search fused by rank, always filtered to the one company." },
  { name: "Cite", detail: "Each quote must appear in its passage and each number in the passage or the filed facts — or it's flagged." },
];

const NOT_DONE = [
  "Intraday prices — end-of-day bhavcopy only.",
  "News, broker notes and model memory on the research side — primary documents only.",
  "A composite 'credibility score' — the Promise Ledger reports a fraction with its denominator.",
  "OCR for scanned PDFs — they're flagged, not silently skipped.",
  "Multi-user accounts — the demo is open, with no sign-in.",
  "The BSE feed — NSE covers the portfolio.",
];

function Stat({ label, children, sub, className }: { label: string; children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("bg-paper px-4 py-4", className)}>
      <dt className="kicker text-ink-faint">{label}</dt>
      <dd className="mt-1.5 font-mono text-[24px] leading-none text-ink tnum">{children}</dd>
      {sub ? <dd className="mt-2 text-[11.5px] leading-snug text-ink-faint">{sub}</dd> : null}
    </div>
  );
}

function Bar({ value, tone = "var(--color-amber)" }: { value: number; tone?: string }) {
  return (
    <span className="mt-2.5 block h-1 overflow-hidden rounded-full bg-white/[0.07]" aria-hidden>
      <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: tone }} />
    </span>
  );
}

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const int = (v: number | null) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));

export function EngineScreen() {
  const { data, error, mutate } = useEngine();
  const now = useNow();
  const llm = data?.llm;
  const tokens = llm ? llm.promptTokensToday + llm.completionTokensToday : null;

  return (
    <PageColumns wide>
      <PageTitle kicker="Engine" title="How FINN works, and what it cost today.">
        Two pipelines. Deterministic code for every number; a small, cached model only where language needs reading.
      </PageTitle>

      <Pipeline kicker="Push" title="Filings in, a short brief out" stages={PUSH} accent="var(--color-act)" />
      <Pipeline kicker="Pull" title="Documents in, cited answers out" stages={PULL} accent="var(--color-know)" />

      <section className="mt-14" aria-labelledby="today-title">
        <div className="flex items-end justify-between border-b border-rule-strong pb-3">
          <h2 id="today-title" className="font-display text-[30px] leading-none text-ink">
            Today&apos;s meter
          </h2>
          <span className="font-mono text-[11px] text-ink-faint" suppressHydrationWarning>
            {data?.asOf && now ? `updated ${timeAgo(data.asOf, now)}` : "live"}
          </span>
        </div>
        {error && !data ? <ErrorState message={(error as Error).message} onRetry={() => void mutate()} /> : null}
        {!data && !error ? <Skeleton className="mt-5 h-48 w-full" /> : null}
        {data && llm ? (
          <>
            <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-rule bg-rule sm:grid-cols-4">
              <Stat label="LLM calls" sub="GLM-5.3-flash, strict JSON schemas">
                <CountUp value={llm.callsToday} format={int} id="eng-calls" />
              </Stat>
              <Stat label="Tokens" sub={`${formatCount(llm.promptTokensToday, true)} in · ${formatCount(llm.completionTokensToday, true)} out`}>
                <CountUp value={tokens} format={(v) => (v == null ? "—" : `${(v / 1e6).toFixed(2)}M`)} id="eng-tokens" />
              </Stat>
              <Stat label="Cache hits" sub={<Bar value={llm.cacheHitRate} />}>
                <CountUp value={llm.cacheHitRate} format={pct} id="eng-cache" />
              </Stat>
              <Stat label="Valid JSON" sub={<Bar value={llm.jsonAdherenceRate} tone="var(--color-pos)" />}>
                <CountUp value={llm.jsonAdherenceRate} format={pct} id="eng-json" />
              </Stat>
              <Stat label="Embedding neurons" sub="of 10,000 free per day">
                <CountUp value={data.embeddings.neuronsToday} format={(v) => (v == null ? "—" : v.toFixed(1))} id="eng-neurons" />
              </Stat>
              <Stat label="Passages indexed">
                <CountUp value={data.embeddings.chunksTotal} format={int} id="eng-chunks" />
              </Stat>
              <Stat label="Documents ready" sub={`${data.documents.failed} failed · ${data.documents.scanned} scanned (flagged)`}>
                <CountUp value={data.documents.ready} format={int} id="eng-docs" />
              </Stat>
              <Stat label="Budget left" sub="calls before FINN serves cached results only">
                <CountUp value={llm.budgetRemaining} format={int} id="eng-budget" />
              </Stat>
            </dl>

            <div className="-mx-5 mt-8 overflow-x-auto px-5">
              <table className="w-full min-w-[340px] border-collapse text-[13px]">
                <caption className="kicker pb-2 text-left text-ink-faint">Calls by purpose</caption>
                <thead>
                  <tr className="kicker text-[10px] text-ink-faint">
                    <th scope="col" className="pb-2 text-left font-normal">
                      Purpose
                    </th>
                    <th scope="col" className="pb-2 text-right font-normal">
                      Calls
                    </th>
                    <th scope="col" className="pb-2 text-right font-normal">
                      Tokens
                    </th>
                    <th scope="col" className="pb-2 text-right font-normal">
                      Cached
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPurpose.map((p) => (
                    <tr key={p.purpose} className="border-t border-rule">
                      <th scope="row" className="py-2.5 text-left font-mono text-[12px] font-normal text-ink-muted">
                        {purposeLabel(p.purpose)}
                      </th>
                      <td className="py-2.5 text-right font-mono text-ink tnum">{int(p.calls)}</td>
                      <td className="py-2.5 text-right font-mono text-ink tnum">{formatCount(p.tokens, true)}</td>
                      <td className="py-2.5 text-right font-mono text-ink-muted tnum">{p.calls ? `${Math.round((p.cacheHits / p.calls) * 100)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>

      {data?.sourceHealth?.length ? (
        <section className="mt-14" aria-labelledby="health-title">
          <h2 id="health-title" className="border-b border-rule-strong pb-3 font-display text-[30px] leading-none text-ink">
            Source health
          </h2>
          <ul className="divide-y divide-rule">
            {data.sourceHealth.map((s) => (
              <li key={s.source} className="flex items-start gap-3 py-3.5">
                <span
                  aria-label={s.stale ? "stale" : s.consecutiveFailures ? "recovering" : "healthy"}
                  className={cn("mt-1.5 size-2 shrink-0 rounded-full", s.stale ? "bg-neg" : s.consecutiveFailures ? "bg-amber" : "bg-pos")}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[14.5px] text-ink">{sourceLabel(s.source)}</p>
                  {s.lastError ? <p className="mt-0.5 text-[12.5px] leading-snug text-ink-faint">{s.lastError}</p> : null}
                </div>
                <div className="shrink-0 text-right font-mono text-[11px] text-ink-faint" suppressHydrationWarning>
                  <p>{s.lastSuccessAt && now ? timeAgo(s.lastSuccessAt, now) : "—"}</p>
                  <p>{s.consecutiveFailures ? `${s.consecutiveFailures} failed` : "ok"}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-14" aria-labelledby="notdone-title">
        <h2 id="notdone-title" className="border-b border-rule-strong pb-3 font-display text-[30px] leading-none text-ink">
          Deliberately not done
        </h2>
        <ul className="mt-2">
          {NOT_DONE.map((n) => (
            <li key={n} className="flex gap-3 border-b border-rule py-3 text-[14px] leading-relaxed text-ink-muted last:border-b-0">
              <span aria-hidden className="font-display text-[18px] leading-none text-ink-faint">
                —
              </span>
              {n}
            </li>
          ))}
        </ul>
      </section>
    </PageColumns>
  );
}
