import type { SourceHealth } from "@finn/shared";
import { CloudOff } from "lucide-react";
import { Notice } from "@/components/ui/states";
import { istDateTime, timeAgo } from "@/lib/format";

const SOURCE_LABEL: Record<string, string> = {
  nse_announcements: "NSE announcements feed",
  nse_integrated_filings: "NSE results (XBRL) feed",
  nse_bhavcopy: "NSE end-of-day prices",
  screener_documents: "Annual report & transcript links",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.replace(/_/g, " ");
}

export function StaleBanner({ sources, now }: { sources: SourceHealth[]; now: Date | null }) {
  const stale = sources.filter((s) => s.stale);
  if (stale.length === 0) return null;
  const first = stale[0]!;
  return (
    <Notice tone="amber" icon={<CloudOff className="size-4" aria-hidden />} title={`${sourceLabel(first.source)} is behind`} className="mt-6">
      {first.lastSuccessAt ? (
        <>
          Last good fetch {now ? timeAgo(first.lastSuccessAt, now) : ""} ({istDateTime(first.lastSuccessAt)}).{" "}
        </>
      ) : null}
      This digest may be missing recent filings, so FINN won&apos;t say you&apos;re caught up. It back-fills automatically on the next successful poll.
      {stale.length > 1 ? ` ${stale.length - 1} other source${stale.length > 2 ? "s are" : " is"} also stale.` : ""}
    </Notice>
  );
}

export function CaughtUp({ noiseCount, windowLabel }: { noiseCount: number; windowLabel: string }) {
  return (
    <div className="mt-12 flex flex-col items-center px-6 text-center">
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden className="text-amber">
        <circle cx="28" cy="28" r="27" fill="none" stroke="currentColor" strokeOpacity="0.35" />
        <path d="M18 29.5l6.5 6.5L38.5 21" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p className="mt-5 font-display text-[34px] leading-tight text-ink">You&apos;re caught up.</p>
      <p className="mt-2 max-w-sm text-[14.5px] leading-relaxed text-ink-muted">
        Nothing material across your holdings in {windowLabel}.
        {noiseCount > 0 ? ` ${noiseCount} routine ${noiseCount === 1 ? "filing is" : "filings are"} folded below.` : ""}
      </p>
    </div>
  );
}
