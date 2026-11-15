import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnswerView, type ReadingProgress, type Turn } from "@/components/research/ask-thread";
import { CitationProvider } from "@/components/research/citation-sheet";
import { askAnswer, run } from "./fixtures/api";

const hooks = vi.hoisted(() => ({ research: {} as Record<string, unknown> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/lib/hooks/use-research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hooks/use-research")>()),
  useResearch: () => hooks.research,
}));

const turn = (over: Partial<Turn> = {}): Turn => ({ id: 1, question: "What did they guide on margins?", status: "done", answer: [], insufficient: true, ...over });
const answer = (t: Turn, reading: ReadingProgress = null) =>
  renderToStaticMarkup(createElement(CitationProvider, null, createElement(AnswerView, { turn: t, reading })));

describe("an answer given before every document was read", () => {
  const early = { read: 3, total: 10 };

  it("says the documents were not read yet instead of saying they don't answer", () => {
    const html = answer(turn({ askedWhileReading: early }), { read: 5, total: 10 });
    expect(html).toContain("Not read yet");
    expect(html).toContain("FINN had read 3 of 10 documents when you asked");
    expect(html).toContain("You can ask again once reading finishes.");
    expect(html).not.toContain("Ask again</");
    expect(html).not.toContain("The documents don&#x27;t answer this");
  });

  it("offers to ask again once reading has finished", () => {
    const html = answer(turn({ askedWhileReading: early }));
    expect(html).toContain("Ask again");
    expect(html).not.toContain("once reading finishes");
  });

  it("covers a question asked before any document was found", () => {
    expect(answer(turn({ askedWhileReading: { read: 0, total: 0 } }))).toContain("FINN had read none of the documents when you asked");
  });

  it("labels a partial answer with how much had been read", () => {
    const html = answer(turn({ ...askAnswer, insufficient: false, askedWhileReading: early }));
    expect(html).toContain("Revenue guidance is 15–18% for FY27.");
    expect(html).toContain("Answered from 3 of 10 documents; the rest were still being read.");
  });

  it("keeps the usual wording for questions asked after reading finished", () => {
    expect(answer(turn())).toContain("The documents don&#x27;t answer this");
    const full = answer(turn({ ...askAnswer, insufficient: false }));
    expect(full).not.toContain("Answered from");
    expect(full).not.toContain("Ask again");
  });
});

describe("the reading banner on the research screen", () => {
  const screen = async () => {
    const { ResearchScreen } = await import("@/components/research/research-screen");
    return renderToStaticMarkup(createElement(CitationProvider, null, createElement(() => ResearchScreen({ symbol: "CDSL" }))));
  };
  const base = { events: [], transport: "sse", cached: false, error: null, starting: false, rebuild: async () => {} };
  const docs = [
    { ...run.documents[0]!, id: "d1", status: "ready" },
    { ...run.documents[0]!, id: "d2", status: "extracting" },
    { ...run.documents[0]!, id: "d3", status: "discovered" },
  ];

  it("shows how many documents have been read while the run is fetching them", async () => {
    hooks.research = { ...base, fetchingDocs: true, run: { ...run, status: "processing_docs", modules: [], documents: docs } };
    expect(await screen()).toContain("Still reading CDSL&#x27;s filings (1 of 3 read). Answers use only what&#x27;s read so far.");
  });

  it("says filings are still being found before the run exists", async () => {
    hooks.research = { ...base, fetchingDocs: true, run: null, starting: true };
    expect(await screen()).toContain("Still finding CDSL&#x27;s filings.");
  });

  it("does not count the previous run's documents while a refresh is starting", async () => {
    hooks.research = { ...base, fetchingDocs: true, run };
    const html = await screen();
    expect(html).toContain("Still finding CDSL&#x27;s filings.");
    expect(html).not.toContain("1 of 1 read");
  });

  it("disappears once documents are in, even while modules are still being written", async () => {
    hooks.research = { ...base, fetchingDocs: false, run: { ...run, status: "synthesizing", modules: [], documents: docs.map((d) => ({ ...d, status: "ready" })) } };
    expect(await screen()).not.toContain("Still reading");
    hooks.research = { ...base, fetchingDocs: false, run };
    expect(await screen()).not.toMatch(/Still (reading|finding)/);
  });
});
