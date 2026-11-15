"use client";

import type { Citation, Claim } from "@finn/shared";
import { CircleSlash } from "lucide-react";
import { InfoPopover } from "@/components/ui/info-popover";
import { cn } from "@/lib/cn";
import { useCitations } from "./citation-sheet";

function shortLabel(c: Citation): string {
  const label = c.documentLabel.replace(/ earnings call( transcript)?/i, " call").replace(/^Annual Report /i, "AR ");
  return c.page ? `${label} · p.${c.page}` : label;
}

export function CitationChips({ citations, claim }: { citations: Citation[]; claim?: string }) {
  const { open } = useCitations();
  if (citations.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-baseline">
      {citations.map((c, i) => (
        <button
          key={c.chunkId}
          type="button"
          onClick={() => open(i === 0 ? citations : [c, ...citations.filter((x) => x !== c)], claim)}
          aria-label={`Source: ${c.documentLabel}${c.page ? `, page ${c.page}` : ""}`}
          className="relative inline-flex h-[22px] items-center rounded-[5px] border border-amber/30 bg-amber-soft px-1.5 font-mono text-[10.5px] leading-none text-amber transition-colors after:absolute after:-inset-x-0.5 after:-inset-y-[11px] after:content-[''] hover:border-amber/60"
        >
          {shortLabel(c)}
        </button>
      ))}
    </span>
  );
}

export function UngroundedMark() {
  return (
    <InfoPopover
      label="Why this could not be grounded"
      trigger={
        <span className="inline-flex h-[22px] items-center gap-1 rounded-[5px] border border-dashed border-neg/45 px-1.5 font-mono text-[10.5px] leading-none text-neg">
          <CircleSlash className="size-3" aria-hidden />
          could not be grounded
        </span>
      }
    >
      FINN looked for a passage in the annual reports and call transcripts that supports this and found none, so it is shown as an open question —
      not as a finding.
    </InfoPopover>
  );
}

/** A claim with its citations inline; ungrounded claims are visibly marked rather than hidden. */
export function ClaimLine({ claim, className, as: Tag = "p" }: { claim: Claim; className?: string; as?: "p" | "li" | "span" }) {
  const grounded = claim.grounded && claim.citations.length > 0;
  return (
    <Tag className={cn("leading-relaxed", grounded ? "text-ink" : "text-ink-muted", className)}>
      <span className={grounded ? undefined : "decoration-neg/40 decoration-dotted underline-offset-4 [text-decoration-line:underline]"}>{claim.text}</span>{" "}
      {grounded ? <CitationChips citations={claim.citations} claim={claim.text} /> : <UngroundedMark />}
    </Tag>
  );
}
