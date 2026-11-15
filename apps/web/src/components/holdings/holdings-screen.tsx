"use client";

import type { Holding } from "@finn/shared";
import { motion } from "motion/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { PageColumns, PageTitle } from "@/components/layout/page";
import { Delta } from "@/components/ui/delta";
import { Segmented } from "@/components/ui/segmented";
import { Sparkline } from "@/components/ui/sparkline";
import { ErrorState, ListSkeleton } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { formatCount, formatMultiple, formatPrice, numberWord } from "@/lib/format";
import { useHoldings } from "@/lib/hooks/data";

type SortKey = "move" | "volume" | "unread" | "name";

const SORTS = [
  { value: "move", label: "Move" },
  { value: "volume", label: "Vol ×" },
  { value: "unread", label: "Unread" },
  { value: "name", label: "A–Z" },
] as const;

const SORTERS: Record<SortKey, (a: Holding, b: Holding) => number> = {
  move: (a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0),
  volume: (a, b) => (b.volumeVsAvg ?? 0) - (a.volumeVsAvg ?? 0),
  unread: (a, b) => b.unreadCount - a.unreadCount || a.symbol.localeCompare(b.symbol),
  name: (a, b) => a.symbol.localeCompare(b.symbol),
};

function sessionLabel(date: string | null | undefined): string {
  if (!date) return "latest session";
  const d = new Date(`${date}T12:00:00+05:30`);
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(d);
}

function HoldingRow({ h, index }: { h: Holding; index: number }) {
  const spike = (h.volumeVsAvg ?? 0) >= 1.5;
  return (
    <motion.li layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 12) * 0.025, duration: 0.35 }}>
      <Link href={`/ask/${h.symbol}`} className="group flex min-h-[68px] items-center gap-2.5 py-3 xs:gap-3 sm:gap-5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[14px] font-semibold tracking-[0.02em] text-ink">{h.symbol}</span>
            {h.researchReady ? <span title="Research ready" aria-label="research ready" className="size-1.5 shrink-0 rounded-full bg-pos" /> : null}
            {h.unreadCount > 0 ? (
              <span aria-label={`${h.unreadCount} unread filings`} className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-act-soft px-1 font-mono text-[10px] text-act">
                {h.unreadCount}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-faint">{h.name}</p>
        </div>
        <Sparkline values={h.sparkline} width={72} height={28} label={`${h.symbol}: 30-session price trend`} className="w-14 shrink-0 xs:w-[72px]" />
        <div className="hidden w-[84px] text-right sm:block">
          <p className={cn("font-mono text-[13px] tnum", spike ? "text-amber" : "text-ink-muted")}>{formatMultiple(h.volumeVsAvg)}</p>
          <p className="font-mono text-[10.5px] text-ink-faint">{formatCount(h.volume, true)}</p>
        </div>
        <div className="w-[88px] shrink-0 text-right xs:w-[96px]">
          <p className="font-mono text-[13.5px] text-ink tnum xs:text-[14px]">{formatPrice(h.close)}</p>
          <Delta value={h.changePct} className="text-[12.5px]" digits={2} />
          <p className={cn("font-mono text-[11px] tnum sm:hidden", spike ? "text-amber" : "text-ink-faint")}>{formatMultiple(h.volumeVsAvg)} vol</p>
        </div>
      </Link>
    </motion.li>
  );
}

export function HoldingsScreen() {
  const { data, error, isLoading, mutate } = useHoldings();
  const [sort, setSort] = useState<SortKey>("move");
  const sorted = useMemo(() => [...(data ?? [])].sort(SORTERS[sort]), [data, sort]);
  const up = data?.filter((h) => (h.changePct ?? 0) > 0).length ?? 0;
  const down = data?.filter((h) => (h.changePct ?? 0) < 0).length ?? 0;
  const unread = data?.reduce((s, h) => s + h.unreadCount, 0) ?? 0;
  const spikes = data?.filter((h) => (h.volumeVsAvg ?? 0) >= 2).length ?? 0;

  return (
    <PageColumns wide>
      <PageTitle kicker={`Holdings · ${sessionLabel(data?.[0]?.sessionDate)}`} title={data ? `${numberWord(data.length)} positions, one glance.` : "Your positions."}>
        End-of-day close and volume from the NSE bhavcopy. Volume is compared with the previous 20 sessions.
      </PageTitle>

      {data ? (
        <dl className="mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-rule bg-rule xs:grid-cols-4">
          {[
            ["Up", up, "text-pos"],
            ["Down", down, "text-neg"],
            ["Vol ≥ 2×", spikes, "text-amber"],
            ["Unread", unread, "text-ink"],
          ].map(([label, value, cls]) => (
            <div key={label as string} className="bg-paper px-3 py-3">
              <dt className="kicker text-[10px] text-ink-faint">{label}</dt>
              <dd className={cn("mt-1 font-mono text-[20px] tnum", cls as string)}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-7 flex items-center justify-between gap-3 border-b border-rule pb-3">
        <p className="kicker text-ink-faint">Sort</p>
        <Segmented label="Sort holdings" value={sort} options={SORTS} onChange={setSort} />
      </div>

      {error ? <ErrorState message={(error as Error).message} onRetry={() => void mutate()} /> : null}
      {isLoading ? <ListSkeleton rows={6} /> : null}
      <ul className="divide-y divide-rule">
        {sorted.map((h, i) => (
          <HoldingRow key={h.symbol} h={h} index={i} />
        ))}
      </ul>
      <p className="mt-6 flex items-center gap-2 font-mono text-[10.5px] text-ink-faint">
        <span className="size-1.5 rounded-full bg-pos" aria-hidden /> research ready ·{" "}
        <span className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-act-soft px-1 text-[10px] text-act">2</span> unread filings
      </p>
    </PageColumns>
  );
}
