"use client";

import type { Alert } from "@finn/shared";
import { ArrowRight, ChartColumn, FileText, TrendingDown, TrendingUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { SymbolChip } from "@/components/ui/badge";
import { ErrorState, ListSkeleton } from "@/components/ui/states";
import { alertsApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { useAlerts } from "@/lib/hooks/data";
import { useNow } from "@/lib/hooks/ui";

function KindIcon({ alert }: { alert: Alert }) {
  const cls = "size-4";
  if (alert.kind === "volume_spike") return <ChartColumn className={cls} aria-label="Volume spike" />;
  if (alert.kind === "price_move") return /fell|down|−|-\d/.test(alert.title) ? <TrendingDown className={cls} aria-label="Price fall" /> : <TrendingUp className={cls} aria-label="Price rise" />;
  return <FileText className={cls} aria-label="Filing" />;
}

export function AlertsFeed() {
  const { data, error, isLoading, mutate } = useAlerts();
  const router = useRouter();
  const now = useNow();
  const unread = data?.filter((a) => !a.readAt).length ?? 0;

  const open = (a: Alert) => {
    if (!a.readAt) {
      void mutate((prev) => prev?.map((x) => (x.id === a.id ? { ...x, readAt: new Date().toISOString() } : x)), { revalidate: false });
      void alertsApi.markAlertRead(a.id).catch(() => {});
    }
    router.push(a.announcementId ? `/?focus=${encodeURIComponent(a.announcementId)}&window=7d` : `/ask/${a.symbol}`);
  };

  return (
    <section aria-labelledby="alerts-title" className="mt-12">
      <div className="flex items-end justify-between border-b border-rule pb-2.5">
        <div>
          <p className="kicker text-ink-faint">Triggered</p>
          <h2 id="alerts-title" className="mt-1 font-display text-[28px] leading-none text-ink">
            Alerts
          </h2>
        </div>
        <span className="pb-1 font-mono text-[12px] text-ink-faint">{data ? (unread ? `${unread} unread` : "all read") : null}</span>
      </div>
      {error && !data ? (
        <div className="mt-4">
          <ErrorState message={`Your alerts didn't load. ${(error as Error).message}`} onRetry={() => void mutate()} />
        </div>
      ) : null}
      {isLoading ? <ListSkeleton rows={3} /> : null}
      <ul className="divide-y divide-rule">
        {data?.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => open(a)} className="group flex w-full gap-3.5 py-4 text-left">
              <span
                className={cn(
                  "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border",
                  a.readAt ? "border-rule text-ink-faint" : "border-act/40 bg-act-soft text-act",
                )}
              >
                <KindIcon alert={a} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <SymbolChip symbol={a.symbol} />
                  <span className="ml-auto font-mono text-[11px] text-ink-faint" suppressHydrationWarning>
                    {now ? timeAgo(a.createdAt, now) : ""}
                  </span>
                </span>
                <span className={cn("mt-1.5 block text-[15.5px] leading-snug", a.readAt ? "text-ink-muted" : "font-medium text-ink")}>{a.title}</span>
                <span className="mt-0.5 block text-[13.5px] leading-relaxed text-ink-muted">{a.body}</span>
                <span className="mt-1.5 flex items-center gap-1 font-mono text-[10.5px] text-ink-faint">
                  {a.ruleName}
                  <ArrowRight className="ml-auto size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {data && data.length === 0 ? <p className="py-8 text-center text-[14px] text-ink-muted">No alerts yet. Rules below decide what reaches you.</p> : null}
    </section>
  );
}
