import { ClaimSchema } from "@finn/shared/contracts/research";
import { describe, expect, it } from "vitest";
import { groundClaims } from "../src/citations/ground";
import { extractNumbers, isExemptNumber, numberSupported } from "../src/citations/numbers";
import { checkClaim, quoteInText, validateClaims, type SourceChunk } from "../src/citations/validator";
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
