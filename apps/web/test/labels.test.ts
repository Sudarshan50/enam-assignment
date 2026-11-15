import { describe, expect, it } from "vitest";
import { callLabel, humanizeKey, purposeLabel, STATEMENT_LABEL } from "@/lib/labels";

describe("LLM purpose labels", () => {
  it("names known purposes in plain English", () => {
    expect(purposeLabel("guidance_extract")).toBe("Reading guidance from calls");
    expect(purposeLabel("bull_bear")).toBe("Bull vs bear case");
    expect(purposeLabel("classify")).toBe("Classifying filings");
  });

  it("handles card and regenerate task names", () => {
    expect(purposeLabel("card.management_change")).toBe("Filing card: management change");
    expect(purposeLabel("bull_bear.regenerate")).toBe("Bull vs bear case (re-grounding)");
  });

  it("humanises anything it doesn't know rather than showing snake_case", () => {
    expect(purposeLabel("cash_quality_notes")).toBe("Cash quality notes");
    expect(humanizeKey("")).toBe("");
  });
});

describe("promise source labels", () => {
  it("turns transcript labels into earnings-call names", () => {
    expect(callLabel("transcript Q2 FY27")).toBe("Q2 FY27 earnings call");
    expect(callLabel("Q2 FY27 concall")).toBe("Q2 FY27 earnings call");
    expect(callLabel("Q1 FY27 call")).toBe("Q1 FY27 earnings call");
    expect(callLabel("Q2 FY27 call (demo)")).toBe("Q2 FY27 earnings call (demo)");
  });

  it("leaves other documents alone", () => {
    expect(callLabel("Annual Report FY26")).toBe("Annual Report FY26");
    expect(callLabel("Q2 FY27 results")).toBe("Q2 FY27 results");
  });

  it("capitalises statement kinds", () => {
    expect(STATEMENT_LABEL.target).toBe("Target");
    expect(STATEMENT_LABEL.aspiration).toBe("Aspiration");
    expect(STATEMENT_LABEL.explicit_guidance).toBe("Explicit guidance");
  });
});
