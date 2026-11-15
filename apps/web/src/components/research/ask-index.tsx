"use client";

import { ArrowRight, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type KeyboardEvent } from "react";
import { PageColumns, PageTitle } from "@/components/layout/page";
import { SymbolChip } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/button";
import type { CompanySearchResult } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useCompanySearch, useHoldings } from "@/lib/hooks/data";
import { useDebounced, useStoredList } from "@/lib/hooks/ui";

const SUGGESTED = [
  { symbol: "CDSL", name: "Central Depository Services", note: "Promise Ledger ready" },
  { symbol: "ASTRAL", name: "Astral", note: "Pipes & adhesives" },
  { symbol: "PAGEIND", name: "Page Industries", note: "Innerwear, Jockey licensee" },
  { symbol: "DEEPAKNTR", name: "Deepak Nitrite", note: "Chemical intermediates" },
];

function ResultRow({ r, active, onPick }: { r: CompanySearchResult; active: boolean; onPick: (s: string) => void }) {
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onClick={() => onPick(r.symbol)}
        className={cn("flex min-h-14 w-full items-center gap-3 px-4 text-left transition-colors", active ? "bg-white/[0.05]" : "hover:bg-white/[0.03]")}
      >
        <SymbolChip symbol={r.symbol} />
        <span className="min-w-0 flex-1 truncate text-[14.5px] text-ink">{r.name}</span>
        {r.inPortfolio ? <span className="kicker text-[9.5px] text-ink-faint">Held</span> : null}
        {r.researchReady ? <span aria-label="research ready" className="size-1.5 rounded-full bg-pos" /> : null}
      </button>
    </li>
  );
}

export function AskIndex() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const debounced = useDebounced(query, 220);
  const search = useCompanySearch(debounced);
  const recent = useStoredList("finn:recent-tickers");
  const holdings = useHoldings();
  const listId = useId();
  const results = query.trim() ? (search.data ?? []) : [];

  const pick = (symbol: string) => {
    const s = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(s)) return;
    recent.push(s);
    router.push(`/ask/${encodeURIComponent(s)}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      pick(hit ? hit.symbol : query);
    }
  };

  return (
    <PageColumns>
      <PageTitle kicker="Ask · Pull mode" title="Research any NSE company.">
        FINN reads its annual reports and earnings-call transcripts — nothing else — and checks what management promised against what they filed.
      </PageTitle>

      <div className="relative mt-8">
        <div className="flex items-center gap-2 rounded-2xl border border-rule-strong bg-paper-raised px-4 focus-within:border-ink-faint">
          <Search className="size-[18px] shrink-0 text-ink-faint" aria-hidden />
          <input
            type="search"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label="Search by NSE symbol or company name"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Symbol or company, e.g. CDSL"
            className="min-h-14 flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-faint focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <IconButton label="Clear search" onClick={() => setQuery("")} className="-mr-2">
              <X className="size-4" />
            </IconButton>
          ) : null}
        </div>
        {query.trim() ? (
          <div className="mt-2 overflow-hidden rounded-2xl border border-rule bg-paper-raised">
            {results.length ? (
              <ul id={listId} role="listbox" aria-label="Matching companies" className="divide-y divide-rule">
                {results.map((r, i) => (
                  <ResultRow key={r.symbol} r={r} active={i === active} onPick={pick} />
                ))}
              </ul>
            ) : (
              <div className="flex min-h-14 items-center justify-between gap-3 px-4 text-[13.5px] text-ink-muted">
                <span>{search.isLoading ? "Searching the NSE list…" : "No listed match. Try the exact NSE symbol."}</span>
                {!search.isLoading && /^[A-Za-z0-9&-]{2,20}$/.test(query.trim()) ? (
                  <button type="button" onClick={() => pick(query)} className="min-h-11 shrink-0 font-mono text-[12px] text-ink underline underline-offset-4">
                    Try {query.trim().toUpperCase()}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {recent.list.length ? (
        <section className="mt-10" aria-labelledby="recent-title">
          <div className="flex items-baseline justify-between border-b border-rule pb-2">
            <h2 id="recent-title" className="kicker text-ink-faint">
              Recent
            </h2>
            <button type="button" onClick={recent.clear} className="min-h-8 text-[12px] text-ink-faint hover:text-ink">
              Clear
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {recent.list.map((s) => (
              <Link key={s} href={`/ask/${s}`} className="inline-flex min-h-11 items-center rounded-full border border-rule-strong px-4 font-mono text-[12.5px] text-ink hover:border-ink-faint">
                {s}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-10" aria-labelledby="suggested-title">
        <h2 id="suggested-title" className="kicker border-b border-rule pb-2 text-ink-faint">
          Suggested
        </h2>
        <ul className="divide-y divide-rule">
          {SUGGESTED.map((s) => (
            <li key={s.symbol}>
              <Link href={`/ask/${s.symbol}`} className="group flex min-h-[68px] items-center gap-4 py-3">
                <span className="w-24 shrink-0 font-mono text-[13px] font-semibold text-ink">{s.symbol}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-[20px] leading-tight text-ink">{s.name}</span>
                  <span className="block truncate text-[12.5px] text-ink-faint">{s.note}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {holdings.data?.length ? (
        <section className="mt-10" aria-labelledby="portfolio-title">
          <h2 id="portfolio-title" className="kicker border-b border-rule pb-2 text-ink-faint">
            From your portfolio
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {holdings.data.map((h) => (
              <Link
                key={h.symbol}
                href={`/ask/${h.symbol}`}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-rule px-3.5 font-mono text-[12px] text-ink-muted hover:border-rule-strong hover:text-ink"
              >
                {h.researchReady ? <span aria-label="research ready" className="size-1.5 rounded-full bg-pos" /> : null}
                {h.symbol}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </PageColumns>
  );
}
