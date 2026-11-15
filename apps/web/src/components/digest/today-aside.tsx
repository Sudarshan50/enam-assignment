"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Delta } from "@/components/ui/delta";
import { Sparkline } from "@/components/ui/sparkline";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { formatMultiple, formatPrice, timeAgo } from "@/lib/format";
import { useAlerts, useHoldings } from "@/lib/hooks/data";
import { useNow } from "@/lib/hooks/ui";

/** Desktop-only right column: the day's biggest movers and the latest triggered alerts. */
export function TodayAside() {
  const holdings = useHoldings();
  const alerts = useAlerts();
  const now = useNow();
  const movers = [...(holdings.data ?? [])].sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0)).slice(0, 5);
  const recent = (alerts.data ?? []).slice(0, 3);

  return (
    <div className="space-y-10">
      <section aria-labelledby="aside-movers">
        <div className="flex items-baseline justify-between border-b border-rule pb-2">
          <h2 id="aside-movers" className="kicker text-ink-faint">
            Biggest moves · last session
          </h2>
          <Link href="/holdings" className="text-[12px] text-ink-faint hover:text-ink">
            All
          </Link>
        </div>
        <ul className="divide-y divide-rule">
          {holdings.isLoading
            ? Array.from({ length: 5 }, (_, i) => (
                <li key={i} className="py-3">
                  <Skeleton className="h-4 w-full" />
                </li>
              ))
            : movers.map((h) => (
                <li key={h.symbol} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[12.5px] font-semibold text-ink">{h.symbol}</p>
                    <p className="font-mono text-[11px] text-ink-faint tnum">
                      {formatPrice(h.close)}
                      {h.volumeVsAvg != null && h.volumeVsAvg >= 1.5 ? <span className="text-amber"> · vol {formatMultiple(h.volumeVsAvg)}</span> : null}
                    </p>
                  </div>
                  <Sparkline values={h.sparkline} width={64} height={24} label={`${h.symbol} 30-session trend`} />
                  <Delta value={h.changePct} className="w-[68px] justify-end text-[12.5px]" />
                </li>
              ))}
        </ul>
        {holdings.error && !holdings.data ? (
          <div className="mt-3">
            <ErrorState message={`Prices didn't load. ${(holdings.error as Error).message}`} onRetry={() => void holdings.mutate()} />
          </div>
        ) : null}
        {holdings.data && holdings.data.length === 0 ? <p className="py-3 text-[13px] text-ink-faint">No holdings to show yet.</p> : null}
      </section>

      <section aria-labelledby="aside-alerts">
        <div className="flex items-baseline justify-between border-b border-rule pb-2">
          <h2 id="aside-alerts" className="kicker text-ink-faint">
            Triggered alerts
          </h2>
          <Link href="/watch" className="text-[12px] text-ink-faint hover:text-ink">
            Watch
          </Link>
        </div>
        <ul className="divide-y divide-rule">
          {recent.map((a) => (
            <li key={a.id} className="py-3">
              <p className="text-[13.5px] leading-snug text-ink">
                {a.readAt ? null : <span aria-label="unread" className="mr-1.5 inline-block size-1.5 -translate-y-0.5 rounded-full bg-act" />}
                {a.title}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-ink-faint" suppressHydrationWarning>
                {now ? timeAgo(a.createdAt, now) : ""} · {a.ruleName}
              </p>
            </li>
          ))}
        </ul>
        {alerts.error && !alerts.data ? (
          <div className="mt-3">
            <ErrorState message={`Alerts didn't load. ${(alerts.error as Error).message}`} onRetry={() => void alerts.mutate()} />
          </div>
        ) : null}
        {alerts.data && alerts.data.length === 0 ? <p className="py-3 text-[13px] text-ink-faint">No alerts have triggered.</p> : null}
      </section>

      <Link
        href="/engine"
        className="group flex items-center justify-between rounded-2xl border border-rule px-4 py-4 text-[13.5px] text-ink-muted transition-colors hover:border-rule-strong hover:text-ink"
      >
        <span>
          <span className="kicker block text-ink-faint">Engine</span>
          How this brief was built, and what it cost
        </span>
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </div>
  );
}
