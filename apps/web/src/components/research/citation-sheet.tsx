"use client";

import type { Citation } from "@finn/shared";
import { ArrowUpRight, FileText } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Sheet } from "@/components/ui/sheet";

interface CitationState {
  citations: Citation[];
  claim: string | null;
}

const CitationContext = createContext<{ open: (citations: Citation[], claim?: string) => void } | null>(null);

function pageUrl(c: Citation): string | null {
  if (!c.url) return null;
  if (!c.page || c.url.includes("#page=")) return c.url;
  return `${c.url}#page=${c.page}`;
}

export function CitationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CitationState | null>(null);
  const open = useCallback((citations: Citation[], claim?: string) => setState({ citations, claim: claim ?? null }), []);
  const close = useCallback(() => setState(null), []);
  const value = useMemo(() => ({ open }), [open]);
  const count = state?.citations.length ?? 0;

  return (
    <CitationContext.Provider value={value}>
      {children}
      <Sheet open={state !== null} onClose={close} kicker={count > 1 ? `${count} sources` : "Source"} title={count > 1 ? "Where this comes from" : (state?.citations[0]?.documentLabel ?? "Source")}>
        {state?.claim ? <p className="mb-5 text-[14px] leading-relaxed text-ink-muted">{state.claim}</p> : null}
        <ol className="space-y-6">
          {state?.citations.map((c) => {
            const href = pageUrl(c);
            return (
              <li key={c.chunkId}>
                <p className="flex items-center gap-2 font-mono text-[11px] text-ink-faint">
                  <FileText className="size-3.5" aria-hidden />
                  {c.documentLabel}
                  {c.page ? ` · page ${c.page}` : ""}
                </p>
                <blockquote className="mt-2.5 border-l-2 border-amber/60 pl-4 font-display text-[21px] leading-[1.35] text-ink italic">
                  &ldquo;{c.quote}&rdquo;
                </blockquote>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
                  >
                    Open {c.page ? `page ${c.page}` : "document"}
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </a>
                ) : (
                  <p className="mt-3 text-[12.5px] text-ink-faint">No public link stored for this document.</p>
                )}
              </li>
            );
          })}
        </ol>
        <p className="mt-8 border-t border-rule pt-4 font-mono text-[10.5px] leading-relaxed text-ink-faint">
          Quotes are checked against the stored passage before a claim is shown. Numbers must appear in the passage or in the filed facts.
        </p>
      </Sheet>
    </CitationContext.Provider>
  );
}

export function useCitations() {
  const ctx = useContext(CitationContext);
  if (!ctx) throw new Error("useCitations must be used inside <CitationProvider>");
  return ctx;
}
