import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Newspaper-style section rule: kicker, serif title, optional meta on the right. */
export function SectionHeading({
  kicker,
  title,
  meta,
  marker,
  className,
  as: Tag = "h2",
}: {
  kicker?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  marker?: string;
  className?: string;
  as?: "h2" | "h3";
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4 border-b border-rule pb-2.5", className)}>
      <div className="min-w-0">
        {kicker ? (
          <p className="kicker flex items-center gap-2 text-ink-faint">
            {marker ? <span aria-hidden className="inline-block size-[7px] rounded-[1.5px]" style={{ background: marker }} /> : null}
            {kicker}
          </p>
        ) : null}
        <Tag className="mt-1 font-display text-[28px] leading-[1.05] tracking-[-0.01em] text-ink">{title}</Tag>
      </div>
      {meta ? <div className="shrink-0 pb-1 text-right">{meta}</div> : null}
    </div>
  );
}
