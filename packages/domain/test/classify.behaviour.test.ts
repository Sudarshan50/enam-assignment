import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "@finn/shared/taxonomy";
import { classifyByRules, LLM_FALLBACK_CONFIDENCE, needsLlmFallback, ROUTINE_REASON, type RuleClassification } from "../src/classify/rules";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../sources/test/fixtures/announcements_2026-11-13.json"), "utf8")) as {
  symbol: string;
  desc: string;
  attchmntText: string;
  voiceSummary: string | null;
}[];

const c = (subject: string, text = "", exchangeSummary: string | null = null) => classifyByRules({ subject, text, exchangeSummary });

describe("every NSE subject in the 13-Nov-2026 snapshot", () => {
  const subjects = [...new Set(fixture.map((r) => r.desc))].sort();

  it.each(subjects)("'%s' is a recognised bucket with a sane result", (subject) => {
    for (const row of fixture.filter((r) => r.desc === subject)) {
      const r = classifyByRules({ subject: row.desc, text: row.attchmntText, exchangeSummary: row.voiceSummary });
      expect(r.reasonCodes[0]).toMatch(/^subject:/);
      expect(r.reasonCodes.some((code) => code.startsWith("subject_unknown"))).toBe(false);
      expect(CATEGORIES).toContain(r.category);
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      // A routine bucket never claims a real category.
      if (r.reasonCodes.includes(ROUTINE_REASON)) expect(r.category).toBe("unclassified");
    }
  });

  it("is deterministic across repeated calls", () => {
    const run = () => fixture.map((r) => classifyByRules({ subject: r.desc, text: r.attchmntText, exchangeSummary: r.voiceSummary }));
    expect(run()).toEqual(run());
  });

  it("only pinned rows carry a pin reason code, and every pin forces confidence >= 0.8", () => {
    for (const row of fixture) {
      const r = classifyByRules({ subject: row.desc, text: row.attchmntText, exchangeSummary: row.voiceSummary });
      expect(r.reasonCodes.some((code) => code.startsWith("pin:"))).toBe(r.pinned === "act");
      if (r.pinned) expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });
});

describe("severity pins force act", () => {
  const pinned = (r: RuleClassification, code: string) => {
    expect(r.pinned).toBe("act");
    expect(r.reasonCodes).toContain(`pin:${code}`);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  };

  it("CIRP: subject bucket, text mention and summary-only mention", () => {
    const subject = c("Corporate Insolvency Resolution Process", "Intimation of admission of CIRP application by NCLT");
    pinned(subject, "insolvency");
    expect(subject.category).toBe("litigation");
    pinned(c("General Updates", "Appointment of Interim Resolution Professional"), "insolvency");
    pinned(c("Updates", "Intimation", "The NCLT admitted a petition and the company is now under corporate insolvency resolution process."), "insolvency");
  });

  it("payment default: text or summary", () => {
    const r = c("Disclosure of material issue", "Delay in payment of interest on non-convertible debentures");
    pinned(r, "payment_default");
    pinned(c("Updates", "Intimation", "The company has defaulted on repayment of a term loan."), "payment_default");
    expect(c("Default in payment of interest/principal", "Intimation").category).toBe("litigation");
  });

  it("fraud pins on subject/text but not on the exchange summary alone", () => {
    pinned(c("Fraud/Default by Promoter/KMP", "Disclosure under Regulation 30"), "fraud");
    pinned(c("General Updates", "Forensic audit initiated by lenders"), "fraud");
    expect(c("General Updates", "Board meeting intimation", "Mentions a fraud prevention policy update.").pinned).toBeNull();
  });

  it("statutory auditor resignation: subject bucket and text under 'Change in Auditors'", () => {
    const bucket = c("Resignation of Statutory Auditor", "Resignation letter attached");
    pinned(bucket, "auditor_resignation");
    expect(bucket.category).toBe("management_change");
    const text = c("Change in Auditors", "The statutory auditors have resigned with immediate effect");
    pinned(text, "auditor_resignation");
    expect(text.category).toBe("management_change");
    // An ordinary rotation is not pinned.
    expect(c("Change in Auditors", "Appointment of M/s ABC & Co as statutory auditors for a second term").pinned).toBeNull();
  });

  it("SEBI penalty order pins; a show-cause notice or a non-regulator penalty does not", () => {
    const order = c("Action(s) taken or orders passed", "Adjudication order", "SEBI imposed a monetary penalty of Rs. 25 lakh on the company.");
    pinned(order, "regulatory_penalty");
    expect(order.category).toBe("litigation");
    pinned(c("Updates", "RBI has levied a penalty of Rs 1.2 crore"), "regulatory_penalty");
    expect(c("Action(s) taken or orders passed", "SEBI show cause notice proposing a penalty of Rs 10 lakh").pinned).toBeNull();
    expect(c("Updates", "GST department imposed a penalty of Rs 5 lakh").pinned).toBeNull();
  });

  it("a pin promotes a routine bucket to the pinned category and drops the routine marker", () => {
    const r = c("Copy of Newspaper Publication", "Public notice regarding corporate insolvency resolution process of the company");
    pinned(r, "insolvency");
    expect(r.category).toBe("litigation");
    expect(r.reasonCodes).not.toContain(ROUTINE_REASON);
    expect(needsLlmFallback(r)).toBe(false);
  });

  it("a pin keeps a meaningful rule category (results stay results)", () => {
    const r = c("Reasons for Delayed/Non-submission of Financial Results", "Company is undergoing CIRP; results delayed");
    expect(r.category).toBe("results");
    expect(r.pinned).toBe("act");
  });

  it("an unknown subject with nothing but a pin becomes the pin category", () => {
    const r = c("Brand New NSE Bucket", "The company is now under liquidation");
    expect(r.category).toBe("litigation");
    expect(r.pinned).toBe("act");
    expect(r.reasonCodes[0]).toBe("subject_unknown:brand_new_nse_bucket");
  });
});

describe("routine buckets skip the LLM", () => {
  it.each([
    ["Trading Window", "Closure of trading window"],
    ["Copy of Newspaper Publication", "Newspaper advertisement"],
    ["Price movement", "Clarification on price movement"],
    ["Spurt in Volume", "Clarification sought"],
    ["Address Change", "Shifting of corporate office"],
    ["Loss of Share Certificate", "Issue of duplicate share certificates"],
    ["ESOP/ESOS/ESPS", "Allotment under ESOP 2020"],
    ["Monitoring Agency Report", "Report for quarter ended September 30, 2026"],
    ["Statement of deviation(s) or variation(s) under Reg. 32", "No deviation"],
    ["Related Party Transactions", "Disclosure of RPT for H1"],
    ["Redemption", "Redemption of commercial paper"],
    ["Amendment to AOA/MOA", "Alteration of articles"],
  ])("%s", (subject, text) => {
    const r = c(subject, text);
    expect(r.category).toBe("unclassified");
    expect(r.reasonCodes).toContain(ROUTINE_REASON);
    expect(needsLlmFallback(r)).toBe(false);
  });

  it("routine text inside a generic bucket is also routine", () => {
    for (const text of ["Intimation of trading window closure", "Compliance certificate under Regulation 74(5)", "ALM statement for H1", "Grant of stock options"]) {
      const r = c("General Updates", text);
      expect(r.reasonCodes).toContain(ROUTINE_REASON);
      expect(needsLlmFallback(r)).toBe(false);
    }
  });

  it("allotment of securities: ESOP allotment is routine, anything else is a fund raise", () => {
    expect(c("Allotment of Securities", "Allotment of 10,000 shares under ESOS 2021").reasonCodes).toContain(ROUTINE_REASON);
    expect(c("Allotment of Securities", "Allotment of 5,00,000 equity shares on preferential basis")).toMatchObject({ category: "fund_raise", confidence: 0.7 });
  });
});

describe("text refinements", () => {
  it("Outcome of Board Meeting: results vs other agenda", () => {
    expect(c("Outcome of Board Meeting", "Approved unaudited financial results for the quarter ended 30-09-2026")).toMatchObject({ category: "results", confidence: 0.9 });
    expect(c("Outcome of Board Meeting", "Appointment of Mr X as Additional Director").category).toBe("management_change");
    expect(c("Outcome of Board Meeting", "Approved raising funds through QIP").category).toBe("fund_raise");
    expect(c("Outcome of Board Meeting", "Approved acquisition of 100% stake in XYZ Pvt Ltd").category).toBe("m_and_a");
    // Results only in the exchange summary: lower confidence.
    expect(c("Outcome of Board Meeting", "Outcome of the board meeting held today", "The board approved the financial results for Q2.")).toMatchObject({
      category: "results",
      confidence: 0.8,
    });
    // Nothing recognisable: unclassified, low confidence, LLM decides.
    const vague = c("Outcome of Board Meeting", "Outcome of the board meeting held today");
    expect(vague.category).toBe("unclassified");
    expect(needsLlmFallback(vague)).toBe(true);
  });

  it("investor meet bucket: transcript vs meeting intimation", () => {
    const subject = "Analysts/Institutional Investor Meet/Con. Call Updates";
    expect(c(subject, "Intimation of schedule of analyst meet on 20 Nov 2026").category).toBe("investor_meetings");
    expect(c(subject, "Transcript of the Q2 FY27 earnings call").category).toBe("earnings_call");
    expect(c(subject, "Audio/video recording link", null).category).toBe("earnings_call");
    expect(c(subject, "Intimation", "Recording of the earnings conference call is available on the website.").category).toBe("earnings_call");
  });

  it("pledge in takeover disclosures and generic buckets", () => {
    expect(c("Disclosure under SEBI Takeover Regulations", "Acquisition of shares by promoter group").category).toBe("insider_trading");
    expect(c("Disclosure under SEBI Takeover Regulations", "Reg 31(1)", "Promoter created a pledge on 2% of shares").category).toBe("pledging");
    expect(c("Pledge of shares", "Pledge created by promoter").category).toBe("pledging");
    expect(c("General Updates", "Invocation of pledged shares by lender").category).toBe("pledging");
  });

  it("bonus, split and dividend via record date and generic text", () => {
    expect(c("Record Date", "Record date for bonus issue in the ratio 1:1").category).toBe("bonus_split");
    expect(c("Record Date", "Record date for sub-division of equity shares").category).toBe("bonus_split");
    expect(c("Record Date", "Record date for interim dividend").category).toBe("dividend");
    const unknown = c("Record Date", "Record date fixed");
    expect(unknown).toMatchObject({ category: "unclassified", confidence: 0.5 });
    expect(needsLlmFallback(unknown)).toBe(true);
    expect(c("Bonus", "Bonus issue").category).toBe("bonus_split");
    expect(c("General Updates", "Board recommended issue of bonus shares").category).toBe("bonus_split");
  });

  it("buyback is a fund raise wherever it appears", () => {
    expect(c("Buyback", "Public announcement for buyback").category).toBe("fund_raise");
    expect(c("General Updates", "Approval of buy-back of equity shares").category).toBe("fund_raise");
  });

  it("press releases are promoted only for material categories", () => {
    expect(c("Press Release", "Press release on the financial results for Q2").category).toBe("results");
    expect(c("Press Release", "Company completes acquisition of ABC").category).toBe("m_and_a");
    expect(c("Press Release", "CRISIL reaffirms rating").category).toBe("credit_rating");
    expect(c("Press Release", "Company launches rights issue").category).toBe("fund_raise");
    expect(c("Press Release", "Board declared interim dividend").category).toBe("press_release");
    expect(c("Press Release", "Trading window closure").category).toBe("press_release");
    expect(c("Press Release", "Media release on new product").category).toBe("press_release");
  });

  it("licenses: withdrawal is litigation, a grant is a press release", () => {
    const subject = "Granting/withdrawal/surrender/cancellation/suspension of key licenses/ regulatory approvals";
    expect(c(subject, "RBI cancelled the certificate of registration").category).toBe("litigation");
    expect(c(subject, "Received approval from USFDA").category).toBe("press_release");
  });

  it("agreements are material only when the text describes a deal", () => {
    expect(c("Agreements", "Execution of share purchase agreement for acquisition").category).toBe("m_and_a");
    expect(needsLlmFallback(c("Agreements", "Agreement with vendor for services"))).toBe(true);
  });

  it("shareholders meeting splits postal ballots from AGMs", () => {
    expect(c("Shareholders meeting", "Notice of postal ballot").category).toBe("postal_ballot");
    expect(c("Shareholders meeting", "Notice of 40th AGM").category).toBe("agm_egm");
  });

  it("unknown subjects fall back to subject+text then summary with modest confidence", () => {
    expect(c("Some Bucket", "Credit rating reaffirmed by ICRA")).toMatchObject({ category: "credit_rating", confidence: 0.65 });
    expect(c("Some Bucket", "nothing", "Company announced a final dividend")).toMatchObject({ category: "dividend", confidence: 0.5 });
    expect(c("", "")).toMatchObject({ category: "unclassified", confidence: 0.3, reasonCodes: [] });
  });

  it("tolerates null-ish inputs", () => {
    const r = classifyByRules({ subject: undefined as unknown as string, text: null as unknown as string, exchangeSummary: null });
    expect(r.category).toBe("unclassified");
  });
});

describe("confidence threshold", () => {
  const result = (category: RuleClassification["category"], confidence: number, reasonCodes: string[] = []): RuleClassification => ({
    category,
    confidence,
    reasonCodes,
    pinned: null,
  });

  it("consults the LLM strictly below the threshold", () => {
    expect(LLM_FALLBACK_CONFIDENCE).toBe(0.6);
    expect(needsLlmFallback(result("dividend", 0.6))).toBe(false);
    expect(needsLlmFallback(result("dividend", 0.5999))).toBe(true);
    expect(needsLlmFallback(result("dividend", 1))).toBe(false);
  });

  it("unclassified always goes to the LLM unless it is a known routine bucket", () => {
    expect(needsLlmFallback(result("unclassified", 0.99))).toBe(true);
    expect(needsLlmFallback(result("unclassified", 0.99, [ROUTINE_REASON]))).toBe(false);
    expect(needsLlmFallback(result("unclassified", 0.4, [ROUTINE_REASON]))).toBe(true);
  });

  it("generic-bucket text matches sit above the threshold, summary-only matches below it", () => {
    expect(needsLlmFallback(c("General Updates", "Disclosure of acquisition of a wholly owned subsidiary"))).toBe(false);
    expect(needsLlmFallback(c("General Updates", "Intimation", "Clarification on financial results"))).toBe(true);
  });
});
