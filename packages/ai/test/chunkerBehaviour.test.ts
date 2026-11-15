import { describe, expect, it } from "vitest";
import { chunkPages, estimateTokens, stripBoilerplate, type PageText } from "../src/chunking/chunker";

const TOPICS = ["dealer additions", "pricing actions", "capacity ramp-up", "export orders", "working capital", "brand spends", "raw material costs"];
const PLACES = ["the new plant", "southern markets", "the export desk", "rural channels", "the pipes division"];

// Body lines must differ in words, not just digits: the boilerplate detector masks digits.
const para = (tag: string, i: number) =>
  `${tag} paragraph ${i}: management discussed ${TOPICS[i % TOPICS.length]} and ${TOPICS[(i * 3 + 1) % TOPICS.length]} at ${PLACES[i % PLACES.length]} in detail during the year.`;

function doc(tag: string, pages: number, linesPerPage: number, extra: { header?: string; footer?: (p: number) => string } = {}): PageText[] {
  let n = 0;
  return Array.from({ length: pages }, (_, p) => {
    const lines = [extra.header, ...Array.from({ length: linesPerPage }, () => para(tag, n++)), extra.footer?.(p + 1)].filter((l): l is string => !!l);
    return { page: p + 1, text: lines.join("\n") };
  });
}

describe("chunker behaviour", () => {
  it("carries text across page boundaries: a chunk can span pages and records both ends", () => {
    const chunks = chunkPages(doc("A", 10, 8));
    expect(chunks.some((c) => c.pageEnd > c.pageStart)).toBe(true);
    for (const c of chunks) {
      const pagesInText = [...c.text.matchAll(/A paragraph (\d+)/g)].map((m) => Math.floor(Number(m[1]) / 8) + 1);
      expect(Math.min(...pagesInText)).toBe(c.pageStart);
      expect(Math.max(...pagesInText)).toBe(c.pageEnd);
    }
  });

  it("overlaps consecutive chunks by roughly 15% of the target size", () => {
    const chunks = chunkPages(doc("A", 20, 10));
    expect(chunks.length).toBeGreaterThan(3);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.text.split("\n");
      const shared = chunks[i]!.text.split("\n").filter((l) => prev.includes(l));
      const overlap = shared.join("\n").length / (800 * 4);
      expect(overlap).toBeGreaterThan(0.08);
      expect(overlap).toBeLessThanOrEqual(0.15);
    }
  });

  it("never mixes documents: chunking two documents separately yields disjoint chunks", () => {
    const a = chunkPages(doc("ALPHA", 6, 8));
    const b = chunkPages(doc("BETA", 6, 8));
    for (const c of a) expect(c.text).not.toContain("BETA");
    for (const c of b) expect(c.text).not.toContain("ALPHA");
    expect(b[0]!.index).toBe(0);
  });

  it("removes running headers and 'Page N of M' footers but keeps body text", () => {
    const pages = doc("A", 6, 3, { header: "Zeta Industries Limited - Investor Call Transcript", footer: (p) => `Page ${p} of 6` });
    const all = chunkPages(pages)
      .map((c) => c.text)
      .join("\n");
    expect(all).not.toMatch(/Zeta Industries Limited - Investor Call Transcript/);
    expect(all).not.toMatch(/Page \d of 6/);
    expect(all).toContain(para("A", 17));
  });

  it("only treats repeated lines as boilerplate when the document has at least 4 pages", () => {
    const pages = doc("A", 3, 2, { header: "Zeta Industries Limited" });
    expect(stripBoilerplate(pages).every((p) => p.text.includes("Zeta Industries Limited"))).toBe(true);
  });

  it("does not strip a repeated line that sits in the middle of the page", () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({
      page: i + 1,
      text: ["l1", "l2", "l3", "l4", "Safe harbour statement applies", "l6", "l7", "l8", "l9"].map((l) => `${l} ${i}`.replace(/^Safe.*/, "Safe harbour statement applies")).join("\n"),
    }));
    expect(stripBoilerplate(pages).every((p) => p.text.includes("Safe harbour statement applies"))).toBe(true);
  });

  it("emits a single chunk for a tiny document", () => {
    const chunks = chunkPages([{ page: 1, text: "Board approved a dividend of ₹2 per share." }]);
    expect(chunks).toEqual([{ index: 0, pageStart: 1, pageEnd: 1, section: null, text: "Board approved a dividend of ₹2 per share.", tokenEstimate: 11 }]);
  });

  it("splits one very long page into several bounded chunks, all on that page", () => {
    const text = Array.from({ length: 300 }, (_, i) => para("L", i)).join(" ");
    const chunks = chunkPages([{ page: 7, text }]);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.pageStart).toBe(7);
      expect(c.pageEnd).toBe(7);
      expect(c.tokenEstimate).toBeLessThanOrEqual(900);
    }
    expect(chunks.map((c) => c.text).join(" ")).toContain(para("L", 299));
  });

  it("hard-splits a single unbroken sentence longer than a unit", () => {
    const chunks = chunkPages([{ page: 1, text: "x".repeat(10_000) }]);
    expect(chunks.map((c) => c.text.replace(/\n/g, "")).join("").length).toBeGreaterThanOrEqual(10_000);
    for (const c of chunks) expect(c.tokenEstimate).toBeLessThanOrEqual(900);
  });

  it("respects custom size options", () => {
    const chunks = chunkPages(doc("A", 4, 10), { targetTokens: 200, minTokens: 150, maxTokens: 250 });
    for (const c of chunks) expect(c.tokenEstimate).toBeLessThanOrEqual(250);
    expect(estimateTokens("abcdefgh", 2)).toBe(4);
  });
});
