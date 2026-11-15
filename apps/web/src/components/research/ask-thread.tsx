"use client";

import type { Claim } from "@finn/shared";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, CircleDashed } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Notice, Skeleton } from "@/components/ui/states";
import { researchApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ClaimLine } from "./claim";

interface Turn {
  id: number;
  question: string;
  status: "loading" | "done" | "error";
  answer: Claim[];
  insufficient: boolean;
  error?: string;
}

const SUGGESTIONS = ["What did they guide on margins?", "Where is the capex going?", "What risks does management name?"];

function AnswerView({ turn }: { turn: Turn }) {
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
  if (turn.insufficient || turn.answer.length === 0) {
    return (
      <Notice icon={<CircleDashed className="size-4" />} title="The documents don't answer this" className="mt-3">
        Nothing in the annual reports or call transcripts clears the relevance bar, so FINN won&apos;t guess.
      </Notice>
    );
  }
  return (
    <ul className="mt-3 space-y-3 text-[15px]">
      {turn.answer.map((c, i) => (
        <motion.li key={c.text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}>
          <ClaimLine claim={c} as="span" />
        </motion.li>
      ))}
    </ul>
  );
}

/** Cited Q&A over this company's documents, with a sticky composer. */
export function AskThread({ symbol, companyName }: { symbol: string; companyName: string }) {
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

  const submit = async (text: string) => {
    const q = text.trim();
    if (q.length < 3 || busy) return;
    seq.current += 1;
    const id = seq.current;
    setQuestion("");
    setTurns((prev) => [...prev, { id, question: q, status: "loading", answer: [], insufficient: false }]);
    try {
      const res = await researchApi.ask(symbol, q);
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, status: "done", answer: res.answer, insufficient: res.insufficientSources } : t)));
    } catch (error) {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, status: "error", error: (error as Error).message } : t)));
    }
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

      <div className="mt-6 space-y-8">
        <AnimatePresence initial={false}>
          {turns.map((t) => (
            <motion.article key={t.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="border-l border-rule-strong pl-4">
              <p className="font-display text-[20px] leading-snug text-ink italic">&ldquo;{t.question}&rdquo;</p>
              <AnswerView turn={t} />
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
