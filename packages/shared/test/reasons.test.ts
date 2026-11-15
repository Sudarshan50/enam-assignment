import { describe, expect, it } from "vitest";
import { describeReason, describeReasons } from "../src/reasons";

describe("reader-facing reasons", () => {
  it("hides classifier provenance and category restatements", () => {
    for (const code of ["subject:board_outcome", "subject_unknown:general_updates", "cluster:child", "text:esop", "routine", "llm_unavailable", "financial_results", "category:"]) {
      expect(describeReason(code)).toBeNull();
    }
  });

  it("phrases rule outcomes, pins and LLM codes that tell the reader something", () => {
    expect(describeReason("auditor_resignation")).toBe("Auditor resigned");
    expect(describeReason("pin:payment_default")).toBe("Payment default");
    expect(describeReason("llm:large_acquisition")).toBe("Large acquisition");
    expect(describeReason("seniority:kmp")).toBe("KMP");
    expect(describeReason("impact:1.2")).toBe("Large for the company");
  });

  it("de-duplicates and drops reasons equal to the category label", () => {
    const codes = ["subject:pledge", "pledge", "pin:fraud", "fraud_default", "llm:pledging"];
    expect(describeReasons(codes, "Pledging")).toEqual(["Fraud or default disclosed"]);
  });
});
