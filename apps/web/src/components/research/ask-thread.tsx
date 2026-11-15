"use client";

import type { Claim } from "@finn/shared";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, CircleDashed, RotateCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Notice, Skeleton } from "@/components/ui/states";
import { researchApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ClaimLine } from "./claim";

/** Documents read so far while the research run is still fetching them; null once the run has finished. */
export type ReadingProgress = { read: number; total: number } | null;

export interface Turn {
  id: number;
  question: string;
  status: "loading" | "done" | "error";
  answer: Claim[];
  insufficient: boolean;
  error?: string;
  /** Set when the question was asked before every document had been read. */
  askedWhileReading?: { read: number; total: number };
}

const SUGGESTIONS = ["What did they guide on margins?", "Where is the capex going?", "What risks does management name?"];

const readSoFar = (p: { read: number; total: number }) => (p.total === 0 ? "none of the documents" : `${p.read} of ${p.total} documents`);

function AskAgain({ reading, onRetry }: { reading: ReadingProgress; onRetry: () => void }) {
  if (reading) return <p className="font-mono text-[11px] text-ink-faint">You can ask again once reading finishes.</p>;
  return (
    <Button size="sm" variant="secondary" onClick={onRetry} icon={<RotateCw className="size-4" aria-hidden />}>
      Ask again
    </Button>
  );
}

export function AnswerView({ turn, reading = null, onRetry = () => {} }: { turn: Turn; reading?: ReadingProgress; onRetry?: () => void }) {
  const early = turn.askedWhileReading;
  if (turn.status === "loading") {
    return (
      <div className="mt-3 space-y-2.5" aria-busy="true">
        <p className="font-mono text-[11px] text-ink-faint">Searching the transcripts and annual reports…</p>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[80%]" />
      </div>
    );
  }
  if (turn.status === "error") return <Notice tone="neg" title="Couldn't answer" className="mt-3">{turn.error}</Notice>;
  if ((turn.insufficient || turn.answer.length === 0) && early) {
    return (
      <Notice
        tone="amber"
        icon={<CircleDashed className="size-4" />}
        title="Not read yet"
        className="mt-3"
        action={<AskAgain reading={reading} onRetry={onRetry} />}
      >
        FINN had read {readSoFar(early)} when you asked, so the answer may be in one it hadn&apos;t reached.
      </Notice>
    );
  }
  if (turn.insufficient || turn.answer.length === 0) {
    return (
      <Notice icon={<CircleDashed className="size-4" />} title="The documents don't answer this" className="mt-3">
        Nothing in the annual reports or call transcripts clears the relevance bar, so FINN won&apos;t guess.
      </Notice>
    );
  }
  return (
    <>
      <ul className="mt-3 space-y-3 text-[15px]">
        {turn.answer.map((c, i) => (
          <motion.li key={c.text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}>
            <ClaimLine claim={c} as="span" />
          </motion.li>
        ))}
      </ul>
      {early ? (
        <div className="mt-3 space-y-2">
          <p className="text-[12.5px] leading-relaxed text-amber">Answered from {readSoFar(early)}; the rest were still being read.</p>
          <AskAgain reading={reading} onRetry={onRetry} />
        </div>
      ) : null}
    </>
  );
}

/** Cited Q&A over this company's documents, with a sticky composer. */
export function AskThread({ symbol, companyName, reading = null }: { symbol: string; companyName: string; reading?: ReadingProgress }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const seq = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const busy = turns.some((t) => t.status === "loading");

  useEffect(() => {
    if (turns.length === 0) return;
    const last = sectionRef.current?.querySelector("article:last-of-type");
    last?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [turns.length]);

  const answer = async (id: number, q: string) => {
    const askedWhileReading = reading ? { ...reading } : undefined;
    try {
      const res = await researchApi.ask(symbol, q);
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, status: "done", answer: res.answer, insufficient: res.insufficientSources, askedWhileReading } : t)));
    } catch (error) {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, status: "error", error: (error as Error).message } : t)));
    }
  };

  const submit = async (text: string) => {
    const q = text.trim();
    if (q.length < 3 || busy) return;
    seq.current += 1;
    const id = seq.current;
    setQuestion("");
    setTurns((prev) => [...prev, { id, question: q, status: "loading", answer: [], insufficient: false }]);
    await answer(id, q);
  };

  const retry = (turn: Turn) => {
    if (busy) return;
    setTurns((prev) => prev.map((t) => (t.id === turn.id ? { ...t, status: "loading", answer: [], insufficient: false, askedWhileReading: undefined } : t)));
    void answer(turn.id, turn.question);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(question);
  };

  return (
    <>
    <section aria-labelledby="ask-title" className="mt-16 scroll-mt-20" ref={sectionRef}>
      <div className="border-b border-rule-strong pb-3">
        <h2 id="ask-title" className="font-display text-[32px] leading-none text-ink">
          Ask the documents
        </h2>
      </div>
      <p className="mt-2.5 text-[13.5px] text-ink-faint">Answers are built only from cited passages. If the sources are silent, FINN says so.</p>
      {reading ? (
        <p role="status" className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-amber">
          <span aria-hidden className="finn-pulse mt-[7px] size-1.5 shrink-0 rounded-full bg-amber" />
          <span>
            {reading.total === 0
              ? `Still finding ${symbol}'s filings. Answers can only use documents FINN has read.`
              : `Still reading ${symbol}'s filings (${reading.read} of ${reading.total} read). Answers use only what's read so far.`}
          </span>
        </p>
      ) : null}

      <div className="mt-6 space-y-8">
        <AnimatePresence initial={false}>
          {turns.map((t) => (
            <motion.article key={t.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="border-l border-rule-strong pl-4">
              <p className="font-display text-[20px] leading-snug text-ink italic">&ldquo;{t.question}&rdquo;</p>
              <AnswerView turn={t} reading={reading} onRetry={() => retry(t)} />
            </motion.article>
          ))}
        </AnimatePresence>
      </div>

      {turns.length === 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void submit(s)}
              className="min-h-11 rounded-full border border-rule-strong px-4 text-left text-[13px] text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </section>

      <form
        onSubmit={onSubmit}
        className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] z-20 mt-8 lg:bottom-6"
        aria-label={`Ask a question about ${companyName}`}
      >
        <div className="flex items-end gap-2 rounded-[22px] border border-rule-strong bg-paper-raised p-1.5 pl-4 shadow-[0_18px_50px_rgba(0,0,0,0.55)] focus-within:border-ink-faint">
          <label htmlFor="ask-input" className="sr-only">
            Question about {companyName}
          </label>
          <textarea
            id="ask-input"
            rows={1}
            value={question}
            maxLength={500}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(question);
              }
            }}
            placeholder={`Ask about ${symbol}…`}
            className="max-h-32 min-h-11 flex-1 resize-none bg-transparent py-3 text-[16px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Ask"
            disabled={busy || question.trim().length < 3}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full transition-colors",
              question.trim().length >= 3 && !busy ? "bg-ink text-paper hover:bg-white" : "bg-white/[0.06] text-ink-faint",
            )}
          >
            <ArrowUp className="size-[18px]" />
          </button>
        </div>
      </form>
    </>
  );
}
