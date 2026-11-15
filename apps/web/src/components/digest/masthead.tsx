"use client";

import type { DigestResponse } from "@finn/shared";
import { RefreshCw } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import type { DigestWindow } from "@/lib/api";
import { cn } from "@/lib/cn";
import { istDateLong, istTime, numberWord, plural } from "@/lib/format";

const WINDOWS = [
  { value: "24h", label: "24h" },
  { value: "3d", label: "3d" },
  { value: "7d", label: "7d" },
] as const;

const WINDOW_PHRASE: Record<DigestWindow, string> = { "24h": "the last 24 hours", "3d": "the last 3 days", "7d": "the last 7 days" };

function headline(act: number, know: number): string {
  if (act > 0) return `${numberWord(act)} ${plural(act, "filing")} ${act === 1 ? "needs" : "need"} you.`;
  if (know > 0) return "Nothing urgent. A few things worth knowing.";
  return "A quiet tape.";
}

export function Masthead({
  digest,
  counts,
  window,
  onWindowChange,
  onRefresh,
  refreshing,
  now,
}: {
  digest: DigestResponse | undefined;
  counts: { act: number; know: number; noise: number } | null;
  window: DigestWindow;
  onWindowChange: (w: DigestWindow) => void;
  onRefresh: () => void;
  refreshing: boolean;
  now: Date | null;
}) {
  return (
    <header className="pt-2">
      <div className="flex items-center justify-between gap-3 text-ink-faint">
        <p className="kicker" suppressHydrationWarning>
          {now ? istDateLong(now) : " "}
        </p>
        <p className="kicker hidden sm:block">NSE · Portfolio of 18</p>
      </div>
      <div className="mt-3 h-px bg-rule-strong" aria-hidden />

      <h1 className="mt-5 font-display text-[44px] leading-[0.98] tracking-[-0.02em] text-ink text-balance sm:text-[56px]">
        {counts ? headline(counts.act, counts.know) : <span className="finn-skeleton inline-block h-[0.9em] w-[80%] align-middle" />}
      </h1>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-muted text-pretty">
        {counts ? (
          <>
            Across your holdings in {WINDOW_PHRASE[window]}:{" "}
            <span className="text-ink">
              {counts.know > 0 ? `${numberWord(counts.know).toLowerCase()} ${counts.act > 0 ? "more " : ""}worth knowing` : counts.act > 0 ? "nothing else worth knowing" : "nothing material"}
            </span>
            {counts.noise > 0 ? `, and ${numberWord(counts.noise).toLowerCase()} routine ${plural(counts.noise, "filing")} folded away.` : "."}
          </>
        ) : (
          "Reading the exchange feed…"
        )}
      </p>

      <div className="mt-5 flex items-center justify-between gap-3">
        <Segmented label="Digest window" value={window} options={WINDOWS} onChange={onWindowChange} />
        <div className="flex items-center gap-1">
          <span className="font-mono text-[11px] text-ink-faint" suppressHydrationWarning>
            {digest?.asOf ? `as of ${istTime(digest.asOf)} IST` : ""}
          </span>
          <IconButton label="Refresh digest" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn("size-[18px]", refreshing && "animate-spin")} />
          </IconButton>
        </div>
      </div>
      <div className="mt-4 space-y-[3px]" aria-hidden>
        <div className="h-px bg-rule-strong" />
        <div className="h-px bg-rule" />
      </div>
    </header>
  );
}
