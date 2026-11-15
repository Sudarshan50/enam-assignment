import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Category } from "@finn/shared/taxonomy";
import { classifyByRules, needsLlmFallback, ROUTINE_REASON } from "../src/classify/rules";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../sources/test/fixtures/announcements_2026-11-13.json"), "utf8")) as {
  seq_id: string;
  symbol: string;
  desc: string;
  attchmntText: string;
  voiceSummary: string | null;
}[];

const classifyRow = (r: (typeof fixture)[number]) => classifyByRules({ subject: r.desc, text: r.attchmntText, exchangeSummary: r.voiceSummary });

/** Expected category per fixture symbol (each row in the 13-Nov-2026 snapshot has a distinct subject). */
const EXPECTED: Record<string, Category> = {
  PAGEIND: "results", // General Updates: clarification on Q2 results
  RELIANCE: "investor_meetings",
  HDFCBANK: "management_change",
  ITC: "unclassified", // ESOP allotment
  TRENT: "unclassified", // dematerialisation reminder
  KDDL: "investor_meetings",
  VERTOZ: "results",
  SARVESHWAR: "m_and_a", // several rows; checked separately below
  TIRUMALCHM: "litigation",
  CGCL: "unclassified",
  RITES: "management_change",
  KISSHT: "investor_meetings",
  JAYKAY: "unclassified",
  RITCO: "results",
  BLS: "management_change",
  INDTERRAIN: "unclassified",
  INDOMIM: "m_and_a",
  SAILIFE: "credit_rating",
  CMSINFO: "management_change",
  GPIL: "unclassified",
  SWELECTES: "results", // ESOP bucket, but the summary is Q2 results
  GSPCROP: "results", // Address Change bucket, but the summary is Q2 results
  TVSSCS: "management_change",
  ASTRON: "litigation",
  ARSHIYA: "results",
  JNPR: "credit_rating",
  HARRMALAYA: "management_change",
  MOTILALOFS: "unclassified",
  SHRIRAMPPS: "management_change",
  BALLARPUR: "management_change",
  INA: "m_and_a",
  POLYPLEX: "management_change", // also a Dividend row, checked below
  BELRISE: "m_and_a",
  SHALPAINTS: "unclassified",
  POWERICA: "litigation",
  FLEXITUFF: "unclassified",
  SHIVAUM: "bonus_split",
  BVCL: "results",
  VNL: "credit_rating",
  BEL: "press_release",
  AKG: "unclassified",
  MUFIN: "press_release",
  IMAGICAA: "fund_raise",
  AHLEAST: "credit_rating",
  NIVABUPA: "unclassified",
  IZMO: "unclassified",
  ZETWERK: "results", // AOA/MOA bucket, but the summary is Q2 results
  DEEDEV: "press_release",
  POONAWALLA: "fund_raise",
  VTL: "unclassified", // bare "Amendment(s)": left to the LLM
  PRECOT: "m_and_a",
  COSMOFIRST: "management_change",
  KOPRAN: "unclassified",
  ZAGGLE: "unclassified",
  VARROC: "insider_trading",
  SHANKARA: "m_and_a",
};

const BY_SUBJECT: Record<string, Category> = {
  "Amalgamation/Merger": "m_and_a",
  "Shareholders meeting": "agm_egm",
  "Agreements": "unclassified",
  "Press Release": "press_release",
  "General Updates": "m_and_a", // SARVESHWAR: wholly owned subsidiary
  "Dividend": "dividend",
  "Change in Company Secretary/Compliance Officer": "management_change",
  "Capacity addition": "capex",
  "Record Date": "dividend",
  "Appointment": "management_change",
  "Retirement": "management_change",
};

describe("classifyByRules on the 13-Nov-2026 NSE snapshot", () => {
  it("covers every row in the fixture", () => {
    expect(fixture.length).toBe(65);
  });

  it.each(fixture.map((r) => [r.symbol, r.desc, r] as const))("%s · %s", (symbol, subject, row) => {
    const result = classifyRow(row);
    const multiRow = fixture.filter((r) => r.symbol === symbol).length > 1;
    const expected = multiRow ? BY_SUBJECT[subject] : EXPECTED[symbol];
    expect(expected, `no expectation for ${symbol} / ${subject}`).toBeDefined();
    expect(result.category).toBe(expected);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.reasonCodes.length).toBeGreaterThan(0);
  });

  it("pins insolvency, auditor resignation and CIRP-flagged delays to act", () => {
    const pinned = fixture.filter((r) => classifyRow(r).pinned === "act").map((r) => r.symbol).sort();
    expect(pinned).toEqual(["ARSHIYA", "ASTRON", "SHRIRAMPPS"]);
    const astron = classifyRow(fixture.find((r) => r.symbol === "ASTRON")!);
    expect(astron.reasonCodes).toContain("pin:insolvency");
    const auditor = classifyRow(fixture.find((r) => r.symbol === "SHRIRAMPPS")!);
    expect(auditor.reasonCodes).toContain("pin:auditor_resignation");
  });

  it("does not pin a tax show-cause notice or a refund order that mention penalties", () => {
    for (const s of ["TIRUMALCHM", "POWERICA"]) expect(classifyRow(fixture.find((r) => r.symbol === s)!).pinned).toBeNull();
  });

  it("marks low-value buckets as routine with high confidence so the LLM is skipped", () => {
    for (const s of ["SHALPAINTS", "INDTERRAIN", "FLEXITUFF", "KOPRAN"]) {
      const r = classifyRow(fixture.find((x) => x.symbol === s)!);
      expect(r.category).toBe("unclassified");
      expect(r.reasonCodes).toContain(ROUTINE_REASON);
      expect(r.confidence).toBeGreaterThanOrEqual(0.85);
      expect(needsLlmFallback(r)).toBe(false);
    }
  });

  it("sends ambiguous buckets to the LLM", () => {
    const agreement = classifyRow(fixture.find((r) => r.symbol === "SARVESHWAR" && r.desc === "Agreements")!);
    expect(agreement.confidence).toBeLessThan(0.6);
    expect(needsLlmFallback(agreement)).toBe(true);
    expect(needsLlmFallback(classifyRow(fixture.find((r) => r.symbol === "VTL")!))).toBe(true);
  });

  it("keeps LLM calls to a small minority of the feed", () => {
    const llm = fixture.filter((r) => needsLlmFallback(classifyRow(r))).length;
    expect(llm).toBeLessThanOrEqual(5);
  });
});

describe("classifyByRules text refinements", () => {
  const c = (subject: string, text: string, exchangeSummary: string | null = null) => classifyByRules({ subject, text, exchangeSummary });

  it("Outcome of Board Meeting + financial results -> results", () => {
    expect(c("Outcome of Board Meeting", "Board approved the Un-audited Financial Results for the quarter ended September 30, 2026").category).toBe("results");
  });

  it("Outcome of Board Meeting + dividend / bonus / buyback", () => {
    expect(c("Outcome of Board Meeting", "Board declared an interim dividend of Rs 5 per share").category).toBe("dividend");
    expect(c("Outcome of Board Meeting", "Board recommended issue of bonus shares in the ratio 1:1").category).toBe("bonus_split");
    expect(c("Outcome of Board Meeting", "Board approved a proposal for buyback of equity shares").category).toBe("fund_raise");
  });

  it("transcripts and recordings -> earnings_call", () => {
    expect(c("Analysts/Institutional Investor Meet/Con. Call Updates", "Transcript of the earnings conference call held on Nov 10").category).toBe("earnings_call");
    expect(c("General Updates", "Audio recording of the earnings call for Q2 FY27").category).toBe("earnings_call");
  });

  it("pledge / encumbrance -> pledging", () => {
    expect(c("Disclosure under SEBI Takeover Regulations", "Disclosure under Regulation 31 regarding creation of encumbrance on shares").category).toBe("pledging");
    expect(c("Updates", "Release of pledge on promoter shares").category).toBe("pledging");
  });

  it("severity pins", () => {
    const fraud = c("General Updates", "Disclosure of fraud detected at a subsidiary");
    expect(fraud.pinned).toBe("act");
    expect(fraud.category).toBe("litigation");
    const def = c("Updates", "Intimation of default in payment of interest on NCDs");
    expect(def.pinned).toBe("act");
    const sebi = c("Action(s) taken or orders passed", "SEBI adjudication order", "SEBI imposed a penalty of Rs. 10 lakh on the company.");
    expect(sebi.pinned).toBe("act");
    expect(sebi.category).toBe("litigation");
  });

  it("unknown subjects fall back to text with modest confidence", () => {
    const r = c("Some New Bucket", "Company has informed the Exchange about something");
    expect(r.category).toBe("unclassified");
    expect(r.confidence).toBeLessThan(0.6);
    expect(needsLlmFallback(r)).toBe(true);
  });
});
