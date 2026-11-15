import type { PromiseItem } from "@finn/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CitationProvider } from "@/components/research/citation-sheet";
import { PromiseLedger } from "@/components/research/promise-ledger";
import { citation } from "./fixtures/api";

const promise = (id: string, verdict: PromiseItem["verdict"], extra: Partial<PromiseItem> = {}): PromiseItem => ({
  id,
  metric: "revenue_growth",
  statementType: "explicit_guidance",
  low: 15,
  high: 18,
  unit: "pct",
  horizonLabel: "FY27",
  horizonEnd: "2027-03-31",
  saidIn: "transcript Q2 FY27",
  speaker: null,
  quote: citation.quote,
  citation,
  actual: null,
  actualPeriod: null,
  actualSource: null,
  verdict,
  explanation: "",
  ...extra,
});

type Summary = { elapsed: number; delivered: number; missed: number; pending: number; quietlyDropped: number };

function render(summary: Summary, promises: PromiseItem[]): string {
  const ledger = { summary, promises, transcriptsUsed: ["Q1 FY27 concall", "Q2 FY27 concall"] };
  return renderToStaticMarkup(createElement(CitationProvider, null, createElement(PromiseLedger, { ledger })));
}

describe("promise ledger headline", () => {
  it("leads with the fraction once deadlines have passed", () => {
    const html = render({ elapsed: 2, delivered: 1, missed: 1, pending: 0, quietlyDropped: 0 }, [promise("a", "delivered"), promise("b", "missed")]);
    expect(html).toContain('aria-label="Delivered 1 of 2"');
  });

  it("says none are due yet when everything is still open", () => {
    const html = render({ elapsed: 0, delivered: 0, missed: 0, pending: 2, quietlyDropped: 0 }, [promise("a", "pending"), promise("b", "pending")]);
    expect(html).toContain('aria-label="None due yet, 2 open"');
    expect(html).toContain("none has reached its deadline yet");
  });

  it("leads with quietly dropped guidance when nothing is due but some was dropped", () => {
    const html = render({ elapsed: 0, delivered: 0, missed: 0, pending: 2, quietlyDropped: 1 }, [
      promise("a", "pending"),
      promise("b", "pending"),
      promise("c", "quietly_dropped"),
    ]);
    expect(html).toContain('aria-label="None due yet, 1 quietly dropped, 2 open"');
    expect(html).toContain("promise quietly dropped");
    expect(html).not.toContain("none has reached its deadline yet");
  });
});

describe("promise rows", () => {
  it("shows reader-facing statement kinds and source names", () => {
    const html = render({ elapsed: 0, delivered: 0, missed: 0, pending: 0, quietlyDropped: 0 }, [
      promise("a", "not_scored", { statementType: "target" }),
      promise("b", "not_scored", { statementType: "aspiration" }),
    ]);
    expect(html).toContain("FY27 · Target");
    expect(html).toContain("FY27 · Aspiration");
    expect(html).toContain("Q2 FY27 earnings call");
    expect(html).not.toContain("transcript Q2 FY27</span>");
  });
});
