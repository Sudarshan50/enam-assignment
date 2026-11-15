/**
 * Reader-facing wording for announcement reason codes. Codes come from the rule classifier
 * (`subject:*`, bare outcome codes, `pin:*`), the LLM fallback (`llm:*`) and card enrichment.
 */

/** Prefixes that only record how a filing was classified, never what it means to the reader. */
const HIDDEN_KEYS = new Set(["category", "subject", "subject_unknown", "text", "cluster"]);

/** Outcome codes worth telling the reader about, beyond the category label. */
const PHRASES: Record<string, string> = {
  insolvency: "Insolvency proceedings",
  fraud: "Fraud or default disclosed",
  fraud_default: "Fraud or default disclosed",
  payment_default: "Payment default",
  auditor_resignation: "Auditor resigned",
  auditor_change: "Auditor change",
  results_delayed: "Results delayed",
  regulatory_action: "Regulatory order",
  regulatory_penalty: "Regulatory penalty",
  order_win: "Order win",
  business_update: "Monthly business update",
  investor_presentation: "Investor presentation",
  open_offer: "Open offer",
  buyback: "Buyback",
  bonus: "Bonus issue",
  split: "Stock split",
  board_or_cxo: "Board / CXO",
  kmp: "KMP",
  senior_management: "Senior management",
};

/** Outcome codes that restate the category or mark routine buckets; showing them adds nothing. */
const SILENT = new Set([
  "routine",
  "llm_unavailable",
  "generic",
  "trading_window",
  "newspaper",
  "price_movement",
  "volume_spurt",
  "address_change",
  "certificates",
  "share_certificates",
  "esop",
  "monitoring_agency",
  "deviation_statement",
  "rpt",
  "redemption",
  "aoa_moa",
  "alm_statement",
  "financial_results",
  "integrated_filing",
  "dividend",
  "credit_rating",
  "management",
  "m_and_a",
  "litigation",
  "press_release",
  "postal_ballot",
  "agm_egm",
  "investor_meet",
  "insider",
  "pledge",
  "fund_raise",
  "capex",
  "transcript",
  "board_outcome",
  "shareholders_meeting",
  "sast",
  "allotment",
  "record_date",
  "license",
  "agreements",
]);

const ACRONYMS = new Set(["pat", "pbt", "nii", "ebitda", "ppop", "cfo", "ceo", "cxo", "md", "ncd", "xbrl", "agm", "egm", "esop", "mcap", "kmp"]);

function humanise(code: string): string {
  return code
    .split("_")
    .filter(Boolean)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (lower === "yoy") return "YoY";
      if (lower === "qoq") return "QoQ";
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ")
    .replace(/(\d)x\b/g, "$1×")
    .replace(/(^|\s)-(?=\d)/g, "$1\u2212");
}

/** "pin:auditor_resignation" → "Auditor resigned"; "subject:generic" → null; "pat_yoy_+14.9%" → "PAT YoY +14.9%". */
export function describeReason(code: string): string | null {
  if (/\s/.test(code)) return code;
  const colon = code.indexOf(":");
  if (colon < 0) return PHRASES[code] ?? (SILENT.has(code) ? null : humanise(code));
  const key = code.slice(0, colon).toLowerCase();
  const value = code.slice(colon + 1);
  if (HIDDEN_KEYS.has(key) || !value) return null;
  if (key === "impact") {
    const n = Number(value);
    return !Number.isFinite(n) ? null : n >= 1.1 ? "Large for the company" : n <= 0.9 ? "Minor for the company" : null;
  }
  return describeReason(value);
}

/** De-duplicated reader-facing reasons, minus any that just repeat the category label. */
export function describeReasons(codes: readonly string[], categoryLabel?: string): string[] {
  const skip = categoryLabel?.toLowerCase();
  const out: string[] = [];
  for (const code of codes) {
    const r = describeReason(code);
    if (r && r.toLowerCase() !== skip && !out.includes(r)) out.push(r);
  }
  return out;
}
