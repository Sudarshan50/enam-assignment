"use client";

import {
  BullBearPayloadSchema,
  BusinessSnapshotPayloadSchema,
  CashQualityPayloadSchema,
  FinancialSnapshotPayloadSchema,
  PromiseLedgerPayloadSchema,
  type ModuleKey,
  type ResearchRun,
} from "@finn/shared";
import { ArrowLeft, RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { PageColumns } from "@/components/layout/page";
import { SymbolChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { istDateTime } from "@/lib/format";
import { useStoredList } from "@/lib/hooks/ui";
import { isTerminalStatus, useResearch } from "@/lib/hooks/use-research";
import { AskThread } from "./ask-thread";
import { BullBearView } from "./bull-bear";
import { BusinessSnapshot } from "./business-snapshot";
import { CashQuality } from "./cash-quality";
import { FinancialSnapshot } from "./financial-snapshot";
import { ModuleFrame } from "./module-frame";
import { PromiseLedger } from "./promise-ledger";
import { ResearchProgress, SourcesList } from "./research-progress";

const JUMP: Array<{ key: ModuleKey; label: string }> = [
  { key: "promise_ledger", label: "Promises" },
  { key: "financial_snapshot", label: "Financials" },
  { key: "cash_quality", label: "Cash" },
  { key: "business_snapshot", label: "Business" },
  { key: "bull_bear", label: "Bull / bear" },
];

const STATUS_LINE: Record<ResearchRun["status"], string> = {
  queued: "Queued",
  processing_docs: "Reading documents",
  synthesizing: "Writing modules",
  completed: "Research ready",
  partial: "Partly ready",
  failed: "Run failed",
  cancelled: "Cancelled",
};

function moduleOf(run: ResearchRun | null, key: ModuleKey) {
  return run?.modules.find((m) => m.key === key);
}

export function ResearchScreen({ symbol }: { symbol: string }) {
  const { run, events, transport, starting, error, rebuild, cached } = useResearch(symbol);
  const recent = useStoredList("finn:recent-tickers");
  const terminal = isTerminalStatus(run?.status);
  const name = run?.companyName ?? symbol;

  useEffect(() => {
    recent.push(symbol);
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageColumns
      aside={
        <div className="space-y-8">
          <SourcesList run={run} />
          <nav aria-label="Modules">
            <h2 className="kicker border-b border-rule pb-2 text-ink-faint">On this page</h2>
            <ul className="mt-1">
              {JUMP.map((j) => (
                <li key={j.key}>
                  <a href={`#${j.key}`} className="flex min-h-10 items-center text-[13.5px] text-ink-muted hover:text-ink">
                    {j.label}
                  </a>
                </li>
              ))}
              <li>
                <a href="#ask-title" className="flex min-h-10 items-center text-[13.5px] text-ink-muted hover:text-ink">
                  Ask the documents
                </a>
              </li>
            </ul>
          </nav>
        </div>
      }
    >
      <Link href="/ask" className="-ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 text-[13px] text-ink-faint hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />
        Ask
      </Link>

      <header className="mt-2">
        <div className="flex items-center gap-2.5">
          <SymbolChip symbol={symbol} />
          <p className="kicker text-ink-faint">Research · NSE</p>
        </div>
        <h1 className="mt-3 font-display text-[44px] leading-[0.98] tracking-[-0.02em] text-ink text-balance sm:text-[56px]">
          {run ? name : starting ? <Skeleton className="h-11 w-3/4" /> : symbol}
        </h1>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-[13.5px] text-ink-muted" suppressHydrationWarning>
            {run ? (
              <>
                <span
                  aria-hidden
                  className={terminal ? "size-1.5 rounded-full bg-pos" : "finn-pulse size-1.5 rounded-full bg-amber"}
                />
                {STATUS_LINE[run.status]}
                {terminal ? ` · ${istDateTime(run.updatedAt)}` : ""}
                {cached && terminal ? <span className="text-ink-faint"> · from cache</span> : null}
              </>
            ) : starting ? (
              "Looking for earlier research…"
            ) : null}
          </p>
          {terminal ? (
            <Button size="sm" variant="ghost" onClick={() => void rebuild()} icon={<RotateCw className="size-4" aria-hidden />}>
              Refresh
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="mt-6">
          <ErrorState message={(error as Error).message} onRetry={() => void rebuild()} />
        </div>
      ) : null}

      {run || events.length ? (
        <div className="mt-6">
          <ResearchProgress run={run} events={events} transport={transport} />
        </div>
      ) : null}

      <nav aria-label="Jump to module" className="scrollbar-none -mx-5 mt-6 flex gap-1.5 overflow-x-auto px-5 lg:hidden">
        {JUMP.map((j) => (
          <a
            key={j.key}
            href={`#${j.key}`}
            className="flex min-h-9 shrink-0 items-center rounded-full border border-rule px-3 text-[12.5px] text-ink-muted hover:text-ink"
          >
            {j.label}
          </a>
        ))}
      </nav>

      <div>
        <ModuleFrame
          index={1}
          title="Promise Ledger"
          subtitle="What management guided on the last four calls, against what they later filed."
          module={moduleOf(run, "promise_ledger")}
          schema={PromiseLedgerPayloadSchema}
        >
          {(ledger) => <PromiseLedger ledger={ledger} />}
        </ModuleFrame>

        <ModuleFrame
          index={2}
          title="Financial snapshot"
          subtitle="Headline numbers from exchange filings; long-run trajectory labelled by source."
          module={moduleOf(run, "financial_snapshot")}
          schema={FinancialSnapshotPayloadSchema}
        >
          {(data) => <FinancialSnapshot data={data} symbol={symbol} />}
        </ModuleFrame>

        <ModuleFrame
          index={3}
          title="Cash quality"
          subtitle="Do profits turn into cash? Matched half-year and full-year periods only."
          module={moduleOf(run, "cash_quality")}
          schema={CashQualityPayloadSchema}
        >
          {(data) => <CashQuality data={data} />}
        </ModuleFrame>

        <ModuleFrame
          index={4}
          title="Business snapshot"
          subtitle="What the company does and where the revenue comes from, in its own words."
          module={moduleOf(run, "business_snapshot")}
          schema={BusinessSnapshotPayloadSchema}
        >
          {(data) => <BusinessSnapshot data={data} />}
        </ModuleFrame>

        <ModuleFrame
          index={5}
          title="Bull vs bear"
          subtitle="A tight case each way. Every line carries its source, or says it has none."
          module={moduleOf(run, "bull_bear")}
          schema={BullBearPayloadSchema}
        >
          {(data) => <BullBearView data={data} />}
        </ModuleFrame>

        <AskThread symbol={symbol} companyName={name} />
      </div>
    </PageColumns>
  );
}
