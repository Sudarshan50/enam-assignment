"use client";

import { CATEGORY_LABELS, type DigestItem as DigestItemData } from "@finn/shared";
import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { ArrowRight, ArrowUpRight, ChevronDown, Paperclip, Pin, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { CardBody } from "@/components/cards/registry";
import { ReasonChip, SymbolChip } from "@/components/ui/badge";
import { Button, ButtonLink, IconButton } from "@/components/ui/button";
import { digestApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { humanizeReason, istDateTime, timeAgo } from "@/lib/format";

const TIER_BAR = { act: "bg-act", know: "bg-know/45", noise: "bg-transparent" } as const;
const TIER_TEXT = { act: "text-act", know: "text-know", noise: "text-noise" } as const;
const SWIPE_DISMISS_PX = 110;

export function DigestItem({
  item,
  index,
  now,
  onDismiss,
  initiallyExpanded = false,
}: {
  item: DigestItemData;
  index: number;
  now: Date | null;
  onDismiss?: (item: DigestItemData) => void;
  initiallyExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [pinned, setPinned] = useState(false);
  const opened = useRef(false);
  const dragged = useRef(false);
  const panelId = useId();
  const router = useRouter();
  const x = useMotionValue(0);
  const revealOpacity = useTransform(x, [-SWIPE_DISMISS_PX, -24, 0], [1, 0.4, 0]);
  const dismissible = Boolean(onDismiss) && item.tier !== "act";
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (initiallyExpanded) root.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [initiallyExpanded]);

  const toggle = () => {
    if (dragged.current) return;
    setExpanded((v) => !v);
    if (!opened.current) {
      opened.current = true;
      void digestApi.recordInteraction(item.id, "open").catch(() => {});
    }
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    setTimeout(() => (dragged.current = false), 50);
    if (info.offset.x < -SWIPE_DISMISS_PX || info.velocity.x < -700) onDismiss?.(item);
  };

  const isAct = item.tier === "act";
  const isNoise = item.tier === "noise";

  return (
    <motion.article
      ref={root}
      layout="position"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -40, transition: { duration: 0.22 } }}
      transition={{ duration: 0.5, delay: Math.min(index, 8) * 0.05, ease: [0.2, 0.7, 0.2, 1] }}
      className="relative border-b border-rule last:border-b-0"
      aria-label={`${item.companyName}: ${item.headline}`}
    >
      <div className="relative overflow-hidden">
        {dismissible ? (
          <motion.div
            aria-hidden
            style={{ opacity: revealOpacity }}
            className="absolute inset-0 flex items-center justify-end bg-neg-soft pr-6 font-mono text-[11px] tracking-[0.12em] text-neg uppercase"
          >
            Dismiss
          </motion.div>
        ) : null}
        <motion.div
          drag={dismissible && !expanded ? "x" : false}
          dragDirectionLock
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={{ left: 0.55, right: 0 }}
          dragSnapToOrigin
          onDragStart={() => (dragged.current = true)}
          onDragEnd={onDragEnd}
          style={{ x }}
          className="relative flex gap-1 bg-paper"
        >
          <span aria-hidden className={cn("absolute top-5 bottom-5 left-0 w-[2px] rounded-full", TIER_BAR[item.tier])} />
          <div className={cn("min-w-0 flex-1 pl-4", isNoise ? "py-3.5" : "py-5")}>
            <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={panelId} className="group block w-full rounded-md text-left">
              <span className="flex items-center gap-2 text-[12.5px] text-ink-faint">
                <SymbolChip symbol={item.symbol} />
                <span className="min-w-0 truncate text-ink-muted">{item.companyName}</span>
                <time dateTime={item.publishedAt} title={istDateTime(item.publishedAt)} className="ml-auto shrink-0 font-mono text-[11px]" suppressHydrationWarning>
                  {now ? timeAgo(item.publishedAt, now) : ""}
                </time>
              </span>
              <span
                className={cn(
                  "mt-2 block text-ink transition-colors group-hover:text-white",
                  isAct ? "font-display text-[24px] leading-[1.12] tracking-[-0.01em]" : isNoise ? "text-[15px] leading-snug text-ink-muted" : "font-display text-[20px] leading-[1.18]",
                )}
              >
                {item.headline}
              </span>
              {item.oneLiner && !isNoise ? <span className="mt-1.5 block text-[14.5px] leading-relaxed text-ink-muted">{item.oneLiner}</span> : null}
            </button>

            {!isNoise ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className={cn("kicker pr-1", TIER_TEXT[item.tier])}>{CATEGORY_LABELS[item.category]}</span>
                {item.reasonCodes
                  .map(humanizeReason)
                  .filter((r) => r.toLowerCase() !== CATEGORY_LABELS[item.category].toLowerCase())
                  .slice(0, 4)
                  .map((r) => (
                    <ReasonChip key={r}>{r}</ReasonChip>
                  ))}
                {item.linked.length > 0 ? (
                  <span className="inline-flex items-center gap-1 pl-1 font-mono text-[10.5px] text-ink-faint">
                    <Paperclip className="size-3" aria-hidden />
                    {item.linked.length} linked
                  </span>
                ) : null}
                <ChevronDown
                  aria-hidden
                  className={cn("ml-auto size-4 text-ink-faint transition-transform duration-300", expanded && "rotate-180")}
                />
              </div>
            ) : null}
          </div>
          {dismissible ? (
            <IconButton label={`Dismiss ${item.symbol}: ${item.headline}`} onClick={() => onDismiss?.(item)} className={cn("-mr-2", isNoise ? "mt-1.5" : "mt-3.5")}>
              <X className="size-4" />
            </IconButton>
          ) : null}
        </motion.div>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            id={panelId}
            key="panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.38, ease: [0.2, 0.7, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-5 pb-6 pl-4">
              {item.card ? (
                <CardBody card={item.card} item={item} />
              ) : (
                <p className="text-[14px] leading-relaxed text-ink-muted">
                  {item.oneLiner ?? "No structured card for this filing — FINN judged the filing itself enough. The PDF is the source."}
                </p>
              )}

              {item.linked.length > 0 ? (
                <div>
                  <p className="kicker text-ink-faint">Linked filings</p>
                  <ul className="mt-1.5 divide-y divide-rule">
                    {item.linked.map((l) => (
                      <li key={l.seqId}>
                        {l.pdfUrl ? (
                          <a
                            href={l.pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex min-h-11 items-center justify-between gap-3 text-[13.5px] text-ink-muted hover:text-ink"
                          >
                            <span className="min-w-0 truncate">{l.headline}</span>
                            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
                          </a>
                        ) : (
                          <span className="flex min-h-11 items-center text-[13.5px] text-ink-faint">{l.headline}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => router.push(`/ask/${item.symbol}`)} icon={<ArrowRight className="size-4" aria-hidden />}>
                  Dig in
                </Button>
                {item.pdfUrl ? (
                  <ButtonLink href={item.pdfUrl} external size="sm" icon={<ArrowUpRight className="size-4" aria-hidden />}>
                    Open filing
                  </ButtonLink>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={pinned}
                  onClick={() => {
                    setPinned((v) => !v);
                    if (!pinned) void digestApi.recordInteraction(item.id, "pin").catch(() => {});
                  }}
                  icon={<Pin className={cn("size-4", pinned && "fill-current")} aria-hidden />}
                >
                  {pinned ? "Pinned" : "Pin"}
                </Button>
                {dismissible ? (
                  <Button variant="ghost" size="sm" onClick={() => onDismiss?.(item)} icon={<X className="size-4" aria-hidden />}>
                    Dismiss
                  </Button>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.article>
  );
}
