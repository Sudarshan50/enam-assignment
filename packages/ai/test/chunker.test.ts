import { describe, expect, it } from "vitest";
import { chunkPages, looksLikeHeading, stripBoilerplate, type PageText } from "../src/chunking/chunker";

const NOUNS = ["distribution", "pricing", "capacity", "exports", "margins", "dealers", "inventory", "branding", "receivables", "plants", "hiring"];
const VERBS = ["expanded", "improved", "stabilised", "tightened", "reshaped", "deepened", "rebuilt"];

function sentence(i: number): string {
  return `Sentence ${i}: the company ${VERBS[i % VERBS.length]} its ${NOUNS[(i * 3) % NOUNS.length]} across ${NOUNS[(i * 5 + 1) % NOUNS.length]} markets this year.`;
}

function makePages(count: number, linesPerPage: number, opts: { header?: boolean; headingEvery?: number } = {}): PageText[] {
  let n = 0;
  return Array.from({ length: count }, (_, p) => {
    const lines: string[] = [];
    if (opts.header) lines.push("ACME Industries Limited | Annual Report 2025-26");
    for (let l = 0; l < linesPerPage; l++) {
      if (opts.headingEvery && n % opts.headingEvery === 0) lines.push(`Section Number ${n / opts.headingEvery + 1} Overview`);
      lines.push(sentence(n++));
    }
    if (opts.header) lines.push(`${p + 1}`);
    return { page: p + 1, text: lines.join("\n") };
  });
}

describe("stripBoilerplate", () => {
  it("removes headers repeated on most pages and bare page numbers", () => {
    const pages = makePages(6, 3, { header: true });
    const out = stripBoilerplate(pages);
    for (const p of out) {
      expect(p.text).not.toContain("ACME Industries Limited");
      expect(p.text.split("\n").some((l) => /^\d+$/.test(l.trim()))).toBe(false);
      expect(p.text).toContain("Sentence");
    }
  });

  it("keeps lines that recur on only a few pages", () => {
    const pages = makePages(8, 2);
    pages[0]!.text += "\nRisk Management Framework";
    pages[1]!.text += "\nRisk Management Framework";
    expect(stripBoilerplate(pages)[0]!.text).toContain("Risk Management Framework");
  });
});

describe("looksLikeHeading", () => {
  it("accepts title-case and all-caps short lines", () => {
    expect(looksLikeHeading("Management Discussion and Analysis")).toBe(true);
    expect(looksLikeHeading("RISKS AND CONCERNS")).toBe(true);
  });
  it("rejects sentences, speaker turns and numbers", () => {
    expect(looksLikeHeading("We expect revenue to grow by 15% next year.")).toBe(false);
    expect(looksLikeHeading("Moderator:")).toBe(false);
    expect(looksLikeHeading("1,234.56 2,345.67")).toBe(false);
  });
});

describe("chunkPages", () => {
  const pages = makePages(30, 12, { header: true, headingEvery: 40 });
  const chunks = chunkPages(pages);

  it("produces chunks within the token budget", () => {
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks.slice(0, -1)) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(900 + 30);
      expect(c.tokenEstimate).toBeGreaterThanOrEqual(500);
    }
  });

  it("indexes chunks sequentially with monotonic page ranges", () => {
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.pageStart).toBeLessThanOrEqual(c.pageEnd);
      if (i > 0) expect(c.pageStart).toBeGreaterThanOrEqual(chunks[i - 1]!.pageStart);
    });
    expect(chunks[0]!.pageStart).toBe(1);
    expect(chunks.at(-1)!.pageEnd).toBe(30);
  });

  it("overlaps consecutive chunks by roughly 15%", () => {
    for (let i = 1; i < chunks.length; i++) {
      const prevLines = chunks[i - 1]!.text.split("\n");
      const firstLine = chunks[i]!.text.split("\n")[0]!;
      expect(prevLines).toContain(firstLine);
    }
    const overlapChars = chunks[1]!.text.split("\n").filter((l) => chunks[0]!.text.includes(l)).join("\n").length;
    expect(overlapChars / chunks[0]!.text.length).toBeGreaterThan(0.05);
    expect(overlapChars / chunks[0]!.text.length).toBeLessThan(0.25);
  });

  it("covers every sentence and drops boilerplate", () => {
    const all = chunks.map((c) => c.text).join("\n");
    for (let i = 0; i < 30 * 12; i += 37) expect(all).toContain(sentence(i));
    expect(all).not.toContain("ACME Industries Limited");
  });

  it("records the section heading a chunk starts under", () => {
    expect(chunks[0]!.section).toBe("Section Number 1 Overview");
    expect(chunks.some((c) => c.section === "Section Number 3 Overview")).toBe(true);
  });

  it("splits a single huge line instead of emitting an oversized chunk", () => {
    const huge = Array.from({ length: 400 }, (_, i) => `Clause ${i} of the agreement applies.`).join(" ");
    const out = chunkPages([{ page: 1, text: huge }]);
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) expect(c.tokenEstimate).toBeLessThanOrEqual(930);
  });

  it("returns nothing for empty input", () => {
    expect(chunkPages([])).toEqual([]);
    expect(chunkPages([{ page: 1, text: "   " }])).toEqual([]);
  });
});
