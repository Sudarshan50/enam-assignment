import { ClaimSchema } from "@finn/shared/contracts/research";
import { describe, expect, it } from "vitest";
import { groundClaims } from "../src/citations/ground";
import { extractNumbers, isExemptNumber, numberSupported } from "../src/citations/numbers";
import { checkClaim, mergeCitations, quoteInText, validateClaims, type SourceChunk } from "../src/citations/validator";
import { buildSourcesBlock } from "../src/prompts/sources";
import { fakeLlm } from "./helpers/fakes";

const mine: SourceChunk = {
  chunkId: "zta-c1",
  documentId: "zta-d1",
  documentLabel: "Q2 FY27 concall",
  url: "https://www.bseindia.com/zta.pdf",
  pageStart: 5,
  pageEnd: 5,
  text: "Revenue for the quarter was ₹1,000 crore. Capex for FY27 is planned at Rs 450 Cr, funded by internal accruals of ₹2.5 lakh. EBITDA margin was 18.6% and exports stood at $1.2 bn. Management said it was “very confident” about demand.",
};
const otherSymbol: SourceChunk = { ...mine, chunkId: "ztb-c9", documentId: "ztb-d9", text: "Revenue for the quarter was ₹9,999 crore at another company." };
const ctx = { chunks: [mine] };

const claim = (text: string, quote: string, chunkId = "zta-c1") => ({ text, citations: [{ chunkId, quote }] });

describe("quote matching", () => {
  it.each([
    ["different case", "REVENUE FOR THE QUARTER WAS ₹1,000 CRORE"],
    ["collapsed whitespace", "Revenue   for the\nquarter    was ₹1,000 crore"],
    ["straight quotes for curly quotes", 'Management said it was "very confident" about demand'],
    ["curly single quotes", "Management said it was \u2018very confident\u2019 about demand".replace(/\u2018|\u2019/g, '"')],
    ["en-dash vs hyphen", "Capex for FY27 is planned at Rs 450 Cr"],
  ])("accepts a quote with %s", (_n, quote) => {
    expect(quoteInText(quote, mine.text)).toBe(true);
  });

  it("rejects paraphrase and partial-word edits", () => {
    expect(quoteInText("Revenue in the quarter was ₹1,000 crore", mine.text)).toBe(false);
    expect(quoteInText("...", mine.text)).toBe(false);
  });
});

describe("checkClaim against the retrieved set", () => {
  it("rejects a verbatim quote from a chunk that was not retrieved", () => {
    const r = checkClaim(claim("Revenue was ₹1,000 crore.", "Revenue for the quarter was ₹1,000 crore", "zta-c-unretrieved"), ctx);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("chunk zta-c-unretrieved is not one of the provided sources");
    expect(r.problems).toContain("no citation could be verified");
  });

  it("rejects a chunk that belongs to another symbol even if its quote is verbatim", () => {
    const r = checkClaim(claim("Revenue was ₹9,999 crore.", "Revenue for the quarter was ₹9,999 crore", otherSymbol.chunkId), ctx);
    expect(r.ok).toBe(false);
  });

  it("rejects an empty claim", () => {
    expect(checkClaim(claim("  ", "Revenue for the quarter was ₹1,000 crore"), ctx).problems).toContain("claim text is empty");
  });
});

describe("number grounding", () => {
  it.each([
    ["₹ crore", "Revenue was ₹1,000 crore.", true],
    ["Rs + Cr", "Capex is planned at Rs. 450 crore.", true],
    ["crore to lakh crore conversion", "Revenue was ₹0.01 lakh crore.", true],
    ["lakh", "Internal accruals of ₹2.5 lakh.", true],
    ["bn", "Exports were $1.2 billion.", true],
    ["percent words", "EBITDA margin was 18.6 per cent.", true],
    ["rounded percent", "EBITDA margin was about 19%.", true],
    ["unsupported percent", "EBITDA margin was 21%.", false],
    ["unsupported crore", "Revenue was ₹1,200 crore.", false],
  ])("%s", (_n, text, ok) => {
    const r = checkClaim(claim(text, "Revenue for the quarter was ₹1,000 crore"), ctx);
    expect(r.ok).toBe(ok);
  });

  it("applies a 1% tolerance: 0.99% off passes, 1.01% off fails", () => {
    const src = extractNumbers("Revenue of ₹1,000.0 crore");
    expect(numberSupported(extractNumbers("₹1,009.9 crore")[0]!, src)).toBe(true);
    expect(numberSupported(extractNumbers("₹990.1 crore")[0]!, src)).toBe(true);
    expect(numberSupported(extractNumbers("₹1,010.2 crore")[0]!, src)).toBe(false);
    expect(numberSupported(extractNumbers("₹989.8 crore")[0]!, src)).toBe(false);
  });

  it("accepts numbers present only in trusted facts, not otherwise", () => {
    const withFacts = checkClaim(claim("Revenue grew 23.4% to ₹1,000 crore.", "Revenue for the quarter was ₹1,000 crore"), { ...ctx, facts: [23.4] });
    expect(withFacts.ok).toBe(true);
    const without = checkClaim(claim("Revenue grew 23.4% to ₹1,000 crore.", "Revenue for the quarter was ₹1,000 crore"), ctx);
    expect(without.problems).toEqual(['number "23.4%" is not in the cited sources']);
  });

  it("matches rupee facts after unit conversion", () => {
    expect(numberSupported(extractNumbers("₹1,000 crore")[0]!, [], [1e10])).toBe(true);
  });

  it("exempts calendar years but not comma-grouped counts that look like years", () => {
    expect(isExemptNumber(extractNumbers("in 2026")[0]!)).toBe(true);
    expect(isExemptNumber(extractNumbers("2,050 dealers")[0]!)).toBe(false);
    const r = checkClaim(claim("The company added 2,050 dealers.", "Revenue for the quarter was ₹1,000 crore"), ctx);
    expect(r.ok).toBe(false);
  });

  it("classifies bps and multiples", () => {
    expect(extractNumbers("up 120 bps, 2.5x leverage, 3 times cover").map((n) => n.dimension)).toEqual(["bps", "multiple", "multiple"]);
  });
});

describe("number units, scale and sign", () => {
  const supports = (claimed: string, source: string) => numberSupported(extractNumbers(claimed)[0]!, extractNumbers(source));

  it("compares money after scaling, never as bare digits", () => {
    expect(supports("₹100 lakh", "₹100 crore")).toBe(false);
    expect(supports("₹100 crore", "₹100 lakh")).toBe(false);
    expect(supports("₹100 crore", "Rs 100 mn")).toBe(false);
    expect(supports("₹1 crore", "₹100 lakh")).toBe(true);
    expect(supports("₹5 thousand", "₹0.05 lakh")).toBe(true);
    expect(supports("₹5 thousand", "₹5 lakh")).toBe(false);
  });

  it("treats basis points as hundredths of a percent", () => {
    expect(supports("100 bps", "100%")).toBe(false);
    expect(supports("100%", "100 bps")).toBe(false);
    expect(supports("1%", "100 bps")).toBe(true);
    expect(supports("125 basis points", "margin up 1.25%")).toBe(true);
  });

  it("never matches figures of different dimensions", () => {
    expect(supports("₹15 crore", "15%")).toBe(false);
    expect(supports("15%", "₹15")).toBe(false);
    expect(supports("2.5x", "2.5%")).toBe(false);
  });

  it("still compares a figure without a unit or scale as written", () => {
    expect(supports("₹450 crore", "Capex 450")).toBe(true);
    expect(supports("450", "Rs 450 Cr")).toBe(true);
    expect(supports("₹1,234 crore", "Revenue (₹) 1,234")).toBe(true);
  });

  it("reads minus signs, bare parenthesised figures and losses as negative", () => {
    const flags = (t: string) => extractNumbers(t).map((n) => n.negative);
    expect(flags("growth of -5% and −3.2%, 21-22% margin, FY26-27")).toEqual([true, true, false, false, false]);
    expect(flags("PAT (1,234.5) vs (₹50 crore) and (18%)")).toEqual([true, false, false]);
    expect(flags("net loss of ₹50 crore; ₹20 crore loss; loss stood at 12")).toEqual([true, true, true]);
    expect(flags("Profit/(Loss) before tax 1,234; loss ratio 12%")).toEqual([false, false]);
  });

  it("does not let a loss support a positive figure, or the reverse", () => {
    expect(supports("profit of ₹50 crore", "net loss of ₹50 crore")).toBe(false);
    expect(supports("a loss of ₹50 crore", "net profit of ₹50 crore")).toBe(false);
    expect(supports("a loss of ₹1,234 crore", "PAT (1,234)")).toBe(true);
    expect(supports("growth of 5%", "growth of -5%")).toBe(false);
    expect(supports("-5%", "growth of -5%")).toBe(true);
  });

  it("rejects a claim whose figure is in the quote with the wrong scale", () => {
    const chunk: SourceChunk = { ...mine, chunkId: "zta-c2", text: "Exports for the year were ₹100 lakh, a record for the unit." };
    const r = checkClaim(claim("Exports were ₹100 crore.", "Exports for the year were ₹100 lakh", "zta-c2"), { chunks: [chunk] });
    expect(r.problems).toEqual(['number "₹100 crore" is not in the cited sources']);
  });
});

describe("elided quotes", () => {
  const filler = "The board also reviewed routine governance matters and approved the minutes of the previous meeting. ";
  const far: SourceChunk = {
    ...mine,
    chunkId: "zta-c3",
    text: `Revenue grew steadily across all regions this year. ${filler.repeat(10)}EBITDA margin expanded to 40% on cost savings.`,
  };
  const near: SourceChunk = {
    ...mine,
    chunkId: "zta-c4",
    text: "Revenue grew steadily across all regions this year, reaching ₹1,000 crore. EBITDA margin expanded to 21% on cost savings.",
  };

  it("requires each fragment to be substantial", () => {
    expect(quoteInText("Revenue grew … 40%", far.text)).toBe(false);
    expect(quoteInText("Revenue grew steadily … margin expanded to 21%", near.text)).toBe(true);
    const r = checkClaim(claim("Revenue grew 40%.", "Revenue grew ... 40%", "zta-c3"), { chunks: [far] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/too short to verify/);
  });

  it("requires fragments in source order", () => {
    expect(quoteInText("EBITDA margin expanded to 21% … Revenue grew steadily across", near.text)).toBe(false);
    expect(quoteInText("Revenue grew steadily across … EBITDA margin expanded to 21%", near.text)).toBe(true);
  });

  it("bounds how much text an ellipsis may skip", () => {
    expect(quoteInText("Revenue grew steadily across all regions … EBITDA margin expanded to 40%", far.text)).toBe(false);
  });

  it("checks claim numbers against the quote's neighbourhood, not the whole chunk", () => {
    const r = checkClaim(claim("Revenue grew 40%.", "Revenue grew steadily across all regions this year", "zta-c3"), { chunks: [far] });
    expect(r.problems).toEqual(['number "40%" is not in the cited sources']);
    const ok = checkClaim(claim("Revenue reached ₹1,000 crore with a 21% margin.", "Revenue grew steadily across all regions this year", "zta-c4"), { chunks: [near] });
    expect(ok.ok).toBe(true);
  });
});

describe("mergeCitations dedupe", () => {
  const base = { chunkId: "zta-c1", documentId: "zta-d1", documentLabel: "Q2 FY27 concall", url: null, page: 5 };

  it("does not drop a quote that is only a numeric suffix of another", () => {
    const out = mergeCitations([
      { ...base, quote: "Revenue grew 15% in FY27" },
      { ...base, quote: "5% in FY27" },
      { ...base, quote: "order book of 1.2 lakh crore" },
      { ...base, quote: "2 lakh crore" },
    ]);
    expect(out.map((c) => c.quote)).toEqual(["Revenue grew 15% in FY27 … 5% in FY27 … order book of 1.2 lakh crore … 2 lakh crore"]);
  });

  it("still drops a quote contained as whole words", () => {
    const out = mergeCitations([
      { ...base, quote: "Revenue grew 15% in FY27" },
      { ...base, quote: "grew 15%" },
    ]);
    expect(out.map((c) => c.quote)).toEqual(["Revenue grew 15% in FY27"]);
  });

  it("joins in source order and keeps unjoinable quotes as separate citations", () => {
    const text = (id: string) => (id === "zta-c1" ? mine.text : undefined);
    const ordered = mergeCitations(
      [
        { ...base, quote: "EBITDA margin was 18.6%" },
        { ...base, quote: "Revenue for the quarter was ₹1,000 crore" },
      ],
      text,
    );
    expect(ordered.map((c) => c.quote)).toEqual(["Revenue for the quarter was ₹1,000 crore … EBITDA margin was 18.6%"]);
    expect(quoteInText(ordered[0]!.quote, mine.text)).toBe(true);

    const farText = `Revenue for the quarter was ₹1,000 crore. ${"Routine governance matters were discussed at length. ".repeat(10)}EBITDA margin was 18.6%.`;
    const separate = mergeCitations(
      [
        { ...base, quote: "Revenue for the quarter was ₹1,000 crore" },
        { ...base, quote: "EBITDA margin was 18.6%" },
      ],
      () => farText,
    );
    expect(separate.map((c) => c.quote)).toEqual(["Revenue for the quarter was ₹1,000 crore", "EBITDA margin was 18.6%"]);
  });
});

describe("regeneration and output contract", () => {
  const sources = buildSourcesBlock([mine]);

  it("regenerates failing claims exactly once, then marks still-failing ones grounded=false", async () => {
    const llm = fakeLlm(() => ({ claims: [claim("Revenue was ₹5,000 crore.", "Revenue for the quarter was ₹5,000 crore", "S1")] }));
    const out = await groundClaims([claim("Revenue was ₹5,000 crore.", "Revenue for the quarter was ₹5,000 crore", "S1")], { llm, task: "t", sources, chunks: [mine] });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.task).toBe("t.regenerate");
    expect(out).toEqual([{ text: "Revenue was ₹5,000 crore.", citations: [], grounded: false }]);
  });

  it("resolves S-aliases and returns ClaimSchema-valid claims with page and URL", async () => {
    const llm = fakeLlm(() => {
      throw new Error("should not be called");
    });
    const out = await groundClaims([claim("  Revenue was ₹1,000 crore.  ", "Revenue for the quarter was ₹1,000 crore", "S1")], { llm, task: "t", sources, chunks: [mine] });
    expect(llm.calls).toHaveLength(0);
    for (const c of out) expect(() => ClaimSchema.parse(c)).not.toThrow();
    expect(out[0]).toEqual({
      text: "Revenue was ₹1,000 crore.",
      grounded: true,
      citations: [{ chunkId: "zta-c1", documentId: "zta-d1", documentLabel: "Q2 FY27 concall", page: 5, quote: "Revenue for the quarter was ₹1,000 crore", url: "https://www.bseindia.com/zta.pdf" }],
    });
  });

  it("keeps the original failure when the regenerator returns fewer claims", async () => {
    const out = await validateClaims([claim("Revenue was ₹7 crore.", "nothing like this text at all")], ctx, async () => []);
    expect(out[0]!.grounded).toBe(false);
  });
});
