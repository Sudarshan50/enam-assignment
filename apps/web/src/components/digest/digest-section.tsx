"use client";

import type { DigestItem as DigestItemData, Tier } from "@finn/shared";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { DigestItem } from "./digest-item";

const COPY: Record<Tier, { kicker: string; title: string; color: string }> = {
  act: { kicker: "Act", title: "Read these first", color: "var(--color-act)" },
  know: { kicker: "Know", title: "Worth knowing", color: "var(--color-know)" },
  noise: { kicker: "Noise", title: "Routine filings", color: "var(--color-noise)" },
};

interface SectionProps {
  tier: Tier;
  items: DigestItemData[];
  now: Date | null;
  onDismiss: (item: DigestItemData) => void;
  focusId?: string | null;
}

function ItemList({ items, now, onDismiss, focusId }: Omit<SectionProps, "tier">) {
  return (
    <div>
      <AnimatePresence initial={false}>
        {items.map((item, i) => (
          <DigestItem key={item.id} item={item} index={i} now={now} onDismiss={onDismiss} initiallyExpanded={item.id === focusId} />
        ))}
      </AnimatePresence>
    </div>
  );
}

export function DigestSection({ tier, items, now, onDismiss, focusId }: SectionProps) {
  if (items.length === 0) return null;
  const copy = COPY[tier];
  return (
    <section aria-labelledby={`sec-${tier}`} className="mt-10 first:mt-8">
      <SectionHeading
        kicker={copy.kicker}
        marker={copy.color}
        title={<span id={`sec-${tier}`}>{copy.title}</span>}
        meta={<span className="font-mono text-[12px] text-ink-faint tnum">{items.length}</span>}
      />
      <ItemList items={items} now={now} onDismiss={onDismiss} focusId={focusId} />
    </section>
  );
}

/** Noise stays folded by default; the count alone tells you the filter is working. */
export function NoiseSection({ items, now, onDismiss, focusId }: Omit<SectionProps, "tier">) {
  const [open, setOpen] = useState(() => Boolean(focusId && items.some((i) => i.id === focusId)));
  const panelId = useId();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="sec-noise" className="mt-10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-rule px-4 text-left transition-colors hover:border-rule-strong hover:bg-white/[0.02]"
      >
        <span className="flex items-center gap-3">
          <span aria-hidden className="inline-block size-[7px] rounded-[1.5px] bg-noise" />
          <span>
            <span id="sec-noise" className="kicker block text-ink-faint">
              Noise
            </span>
            <span className="text-[14.5px] text-ink-muted">
              {items.length} routine {plural(items.length, "filing")} folded away
            </span>
          </span>
        </span>
        <ChevronDown aria-hidden className={cn("size-4 text-ink-faint transition-transform duration-300", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.2, 0.7, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="pt-2">
              <ItemList items={items} now={now} onDismiss={onDismiss} focusId={focusId} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
