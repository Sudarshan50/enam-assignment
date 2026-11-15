"use client";

import type { ResearchEvent, ResearchRun } from "@finn/shared";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, CircleAlert } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { istDateTime } from "@/lib/format";
import { isTerminalStatus, type Transport } from "@/lib/hooks/use-research";

function EventRow({ event, live, first }: { event: ResearchEvent; live: boolean; first: ResearchEvent | undefined }) {
  const failed = event.type.endsWith(".failed");
  const offset = first ? (new Date(event.createdAt).getTime() - new Date(first.createdAt).getTime()) / 1000 : 0;
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3 }}
      className="relative flex gap-3 pb-3.5 last:pb-0"
    >
      <span className="relative z-10 mt-[3px] flex size-[15px] shrink-0 items-center justify-center rounded-full border border-rule-strong bg-paper">
        {failed ? (
          <CircleAlert className="size-3 text-neg" aria-hidden />
        ) : live ? (
          <span className="finn-pulse size-[7px] rounded-full bg-amber" aria-hidden />
        ) : (
          <Check className="size-2.5 text-ink-faint" aria-hidden />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 text-[13.5px] leading-snug", live ? "text-ink" : failed ? "text-neg" : "text-ink-muted")}>{event.message}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-ink-faint tnum">+{offset < 60 ? `${offset.toFixed(1)}s` : `${Math.round(offset / 60)}m`}</span>
    </motion.li>
  );
}

function Timeline({ events, live }: { events: ResearchEvent[]; live: boolean }) {
  return (
    <ol className="relative before:absolute before:top-2 before:bottom-2 before:left-[7px] before:w-px before:bg-rule-strong" aria-live="polite">
      <AnimatePresence initial={false}>
        {events.map((e, i) => (
          <EventRow key={e.id} event={e} live={live && i === events.length - 1} first={events[0]} />
        ))}
      </AnimatePresence>
    </ol>
  );
}

export function ResearchProgress({ run, events, transport }: { run: ResearchRun | null; events: ResearchEvent[]; transport: Transport }) {
  const terminal = isTerminalStatus(run?.status);
  const [open, setOpen] = useState(false);
  const id = useId();
  const discovered = events.find((e) => e.type === "document.discovered");

  if (terminal) {
    return (
      <div className="rounded-2xl border border-rule">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={id}
          className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-left"
        >
          <span className="min-w-0">
            <span className="kicker block text-ink-faint">How this was built</span>
            <span className="block truncate text-[13.5px] text-ink-muted">
              {discovered?.message ?? `${run?.documents.length ?? 0} documents`}
              {run ? ` · ${istDateTime(run.updatedAt)}` : ""}
            </span>
          </span>
          <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-ink-faint transition-transform", open && "rotate-180")} />
        </button>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div id={id} initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
              <div className="border-t border-rule px-4 py-4">
                {events.length ? <Timeline events={events} live={false} /> : <p className="text-[13px] text-ink-faint">No event history was kept for this run.</p>}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-amber/25 bg-amber-soft/50 px-4 py-4" role="status">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="kicker text-amber">Reading the primary sources</p>
        <p className="font-mono text-[10.5px] text-ink-faint">{transport === "polling" ? "checking every 3s" : "live"}</p>
      </div>
      {events.length ? <Timeline events={events} live /> : <p className="text-[13.5px] text-ink-muted">Queuing the run…</p>}
      <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
        A company FINN hasn&apos;t read before takes one to three minutes. Modules appear as they finish; you can leave and come back.
      </p>
    </div>
  );
}

export function SourcesList({ run }: { run: ResearchRun | null }) {
  if (!run || run.documents.length === 0) return null;
  return (
    <section aria-labelledby="sources-title">
      <h2 id="sources-title" className="kicker border-b border-rule pb-2 text-ink-faint">
        Sources read · {run.documents.length}
      </h2>
      <ul className="divide-y divide-rule">
        {run.documents.map((d) => (
          <li key={d.id}>
            <a
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center justify-between gap-3 py-2 text-[13px] text-ink-muted hover:text-ink"
            >
              <span className="min-w-0 truncate">{d.label}</span>
              <span className={cn("shrink-0 font-mono text-[10.5px]", d.status === "ready" ? "text-ink-faint" : "text-amber")}>
                {d.status === "ready" ? `${d.pages ?? "?"} pp` : d.status}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">Annual reports and earnings-call transcripts only. No news, no broker notes, no model memory.</p>
    </section>
  );
}
