import type { Category } from "@finn/shared/taxonomy";

export interface RuleClassificationInput {
  /** NSE subject bucket (`desc`), e.g. "Outcome of Board Meeting". */
  subject: string;
  /** Short exchange text (`attchmntText`). */
  text: string;
  /** Exchange-generated long summary, when present. */
  exchangeSummary: string | null;
}

export interface RuleClassification {
  category: Category;
  confidence: number;
  reasonCodes: string[];
  pinned: "act" | null;
}

/** Below this the LLM classifier is consulted. */
export const LLM_FALLBACK_CONFIDENCE = 0.6;

/** Reason code marking a known low-value bucket; such rows skip the LLM even though they are `unclassified`. */
export const ROUTINE_REASON = "routine";

export function needsLlmFallback(result: RuleClassification): boolean {
  if (result.confidence < LLM_FALLBACK_CONFIDENCE) return true;
  return result.category === "unclassified" && !result.reasonCodes.includes(ROUTINE_REASON);
}

type Refine = (text: string, summary: string) => Outcome | null;

interface Outcome {
  category: Category;
  confidence: number;
  code: string;
  routine?: boolean;
}

interface SubjectRule {
  match: RegExp;
  code: string;
  outcome?: Omit<Outcome, "code">;
  /** Bucket-specific text refinements tried before `outcome`. */
  refine?: Refine;
  /** When neither refine nor outcome applies, fall through to generic text matching. */
  generic?: boolean;
}

const routine = (confidence = 0.9): Omit<Outcome, "code"> => ({ category: "unclassified", confidence, routine: true });
const is = (category: Category, confidence: number): Omit<Outcome, "code"> => ({ category, confidence });

// ---------- Text patterns (order matters: specific before broad) ----------

interface TextPattern {
  code: string;
  re: RegExp;
  category: Category;
  routine?: boolean;
}

const TRANSCRIPT_RE = /transcript|audio( and video| \/ video|\/video)? recording|recording of (the )?(earnings|conference|investor)/i;
const M_AND_A_RE =
  /acqui(re|sition)|amalgamation|\bmerger\b|demerger|scheme of arrangement|joint venture|share purchase agreement|stake (sale|in)|transfer of (equity )?shares held|wholly[- ]owned subsidiary/i;

const TEXT_PATTERNS: TextPattern[] = [
  { code: "trading_window", re: /trading window/i, category: "unclassified", routine: true },
  { code: "newspaper", re: /newspaper (publication|advertisement)|copy of (the )?newspaper/i, category: "unclassified", routine: true },
  {
    code: "share_certificates",
    re: /(loss|duplicate|issue) of (share )?certificate|dematerial[iz]|regulation 74 ?\(5\)|compliance certificate/i,
    category: "unclassified",
    routine: true,
  },
  { code: "alm_statement", re: /\bALM\b|asset liability management/i, category: "unclassified", routine: true },
  { code: "esop", re: /\bESOP|\bESOS|\bESPS|stock options?|employee stock/i, category: "unclassified", routine: true },
  { code: "transcript", re: TRANSCRIPT_RE, category: "earnings_call" },
  { code: "pledge", re: /\bpledg|encumbrance|encumbered/i, category: "pledging" },
  { code: "bonus", re: /\bbonus (issue|shares|equity)|issue of bonus/i, category: "bonus_split" },
  { code: "split", re: /sub-?division|stock split|split of (equity )?shares/i, category: "bonus_split" },
  { code: "buyback", re: /buy-?back/i, category: "fund_raise" },
  {
    code: "financial_results",
    re: /financial results?|quarterly results|un-?audited results|revised results|results for the (quarter|period|half|year)/i,
    category: "results",
  },
  { code: "credit_rating", re: /credit rating|rating (agency|action)|\b(CRISIL|ICRA|CARE|India Ratings|Infomerics|Acuite)\b/i, category: "credit_rating" },
  { code: "dividend", re: /\bdividend\b/i, category: "dividend" },
  { code: "insider", re: /regulation 7 ?\(2\)|regulation 29|regulation 10 ?\(5\)|substantial acquisition|insider trading\)? regulations?.*disclos/i, category: "insider_trading" },
  { code: "open_offer", re: /open offer/i, category: "m_and_a" },
  { code: "m_and_a", re: M_AND_A_RE, category: "m_and_a" },
  {
    code: "fund_raise",
    re: /preferential (issue|allotment)|qualified institution|\bQIP\b|rights issue|non-convertible debentures|\bNCDs?\b|commercial paper|convertible warrants|fund ?rais/i,
    category: "fund_raise",
  },
  { code: "capex", re: /capacity (addition|expansion)|commission(ed|ing) of|new (plant|facility)|greenfield|brownfield|capital expenditure|\bcapex\b/i, category: "capex" },
  { code: "order_win", re: /orders? (worth|valued|of rs)|bagged|letter of (award|intent)|\bLoA\b|contract (worth|from|valued)/i, category: "press_release" },
  {
    code: "management",
    re: /appointment|appointed|resignation|resigned|cessation|re-?appointment|retirement|managing director|chief (executive|financial|operating) officer|company secretary|key managerial/i,
    category: "management_change",
  },
  {
    code: "litigation",
    re: /show cause|penalty|tribunal|high court|supreme court|arbitration|litigation|dispute|demand notice|tax demand|assessment order/i,
    category: "litigation",
  },
  { code: "postal_ballot", re: /postal ballot|remote e-?voting/i, category: "postal_ballot" },
  { code: "agm_egm", re: /annual general meeting|\bAGM\b|extra-?ordinary general meeting|\bEGM\b/i, category: "agm_egm" },
  { code: "investor_meet", re: /investor(s'?)? meet|analyst(s'?)? meet|conference call|con\. ?call|earnings call|institutional investor/i, category: "investor_meetings" },
  { code: "press_release", re: /press release|media release/i, category: "press_release" },
];

function matchText(source: string, confidence: number): Outcome | null {
  if (!source) return null;
  for (const p of TEXT_PATTERNS) {
    if (p.re.test(source)) return { category: p.category, confidence, code: `text:${p.code}`, routine: p.routine };
  }
  return null;
}

function firstMatch(text: string, entries: [RegExp, Category, string][], confidence: number): Outcome | null {
  for (const [re, category, code] of entries) {
    if (re.test(text)) return { category, confidence, code: `text:${code}` };
  }
  return null;
}

const SUBJECT_RULES: SubjectRule[] = [
  // Noise buckets first, so text inside them can't promote them.
  { match: /^trading window/i, code: "trading_window", outcome: routine(0.95) },
  { match: /newspaper publication/i, code: "newspaper", outcome: routine(0.9) },
  { match: /^price movement/i, code: "price_movement", outcome: routine(0.9) },
  { match: /^spurt in volume/i, code: "volume_spurt", outcome: routine(0.9) },
  { match: /^address change|change in registered office/i, code: "address_change", outcome: routine(0.9) },
  { match: /loss of share certificate|duplicate share certificate|certificate under sebi|reg\.? ?74/i, code: "certificates", outcome: routine(0.9) },
  { match: /^esop|^esos|^esps|options to purchase securities/i, code: "esop", outcome: routine(0.85) },
  { match: /^monitoring agency report/i, code: "monitoring_agency", outcome: routine(0.85) },
  { match: /^statement of deviation/i, code: "deviation_statement", outcome: routine(0.8) },
  { match: /^related party transactions/i, code: "rpt", outcome: routine(0.75) },
  { match: /^redemption/i, code: "redemption", outcome: routine(0.8) },
  { match: /^amendment to (aoa|moa)/i, code: "aoa_moa", outcome: routine(0.75) },

  { match: /corporate insolvency|insolvency and bankruptcy|\bCIRP\b/i, code: "insolvency", outcome: is("litigation", 0.95) },
  { match: /^fraud|default by (promoter|kmp|unlisted)/i, code: "fraud_default", outcome: is("litigation", 0.95) },
  { match: /default (in|on) payment|delay in (payment|servicing)/i, code: "payment_default", outcome: is("litigation", 0.95) },
  { match: /resignation of statutory auditor/i, code: "auditor_resignation", outcome: is("management_change", 0.95) },

  { match: /^integrated filing.*financial/i, code: "integrated_filing", outcome: is("results", 0.95) },
  { match: /^financial results?|^financial result updates/i, code: "financial_results", outcome: is("results", 0.95) },
  { match: /delayed\/non-submission of financial results|non-submission of financial results/i, code: "results_delayed", outcome: is("results", 0.75) },
  {
    match: /^outcome of board meeting/i,
    code: "board_outcome",
    refine: (text, summary) =>
      matchText(text, 0.9) ?? firstMatch(summary, [[/financial results/i, "results", "financial_results"]], 0.8),
    generic: true,
  },

  {
    match: /analysts\/institutional investor meet|con\. ?call/i,
    code: "investor_meet",
    refine: (text, summary) => firstMatch(`${text}\n${summary}`, [[TRANSCRIPT_RE, "earnings_call", "transcript"]], 0.9),
    outcome: is("investor_meetings", 0.9),
  },
  { match: /^investor presentation/i, code: "investor_presentation", outcome: is("investor_meetings", 0.75) },
  {
    match: /^shareholders meeting/i,
    code: "shareholders_meeting",
    refine: (text) => firstMatch(text, [[/postal ballot/i, "postal_ballot", "postal_ballot"]], 0.9),
    outcome: is("agm_egm", 0.8),
  },
  { match: /postal ballot/i, code: "postal_ballot", outcome: is("postal_ballot", 0.9) },
  { match: /\bAGM\b|\bEGM\b|annual general meeting|general meeting/i, code: "agm_egm", outcome: is("agm_egm", 0.85) },

  { match: /^change in (director|management|company secretary|key managerial)/i, code: "management", outcome: is("management_change", 0.9) },
  { match: /^appointment|^resignation|^cessation|^retirement|^demise|^re-?appointment/i, code: "management", outcome: is("management_change", 0.9) },
  { match: /^change in auditors/i, code: "auditor_change", outcome: is("management_change", 0.65) },

  { match: /^acquisition|^amalgamation|^merger|^demerger|^scheme of arrangement|open offer|^sale or disposal|^divestment/i, code: "m_and_a", outcome: is("m_and_a", 0.9) },
  {
    match: /takeover regulations|SEBI \(SAST\)|substantial acquisition/i,
    code: "sast",
    refine: (text, summary) => firstMatch(`${text}\n${summary}`, [[/\bpledg|encumbrance|encumbered/i, "pledging", "pledge"]], 0.9),
    outcome: is("insider_trading", 0.8),
  },
  { match: /insider trading|SEBI \(PIT\)|prohibition of insider/i, code: "insider", outcome: is("insider_trading", 0.85) },
  { match: /pledge|encumbrance/i, code: "pledge", outcome: is("pledging", 0.95) },
  { match: /^preferential issue|^issue of securities|^qualified institutions placement|^rights issue|^private placement/i, code: "fund_raise", outcome: is("fund_raise", 0.9) },
  {
    match: /^allotment of securities/i,
    code: "allotment",
    refine: (text) => (/\bESOP|\bESOS|\bESPS|stock option/i.test(text) ? { ...routine(0.85), code: "text:esop" } : null),
    outcome: is("fund_raise", 0.7),
  },
  { match: /buy ?back/i, code: "buyback", outcome: is("fund_raise", 0.9) },
  { match: /^dividend/i, code: "dividend", outcome: is("dividend", 0.95) },
  { match: /^bonus/i, code: "bonus", outcome: is("bonus_split", 0.95) },
  { match: /^stock split|sub-?division/i, code: "split", outcome: is("bonus_split", 0.95) },
  {
    match: /^record date/i,
    code: "record_date",
    refine: (text) =>
      firstMatch(
        text,
        [
          [/\bbonus\b/i, "bonus_split", "bonus"],
          [/split|sub-?division/i, "bonus_split", "split"],
          [/\bdividend\b/i, "dividend", "dividend"],
        ],
        0.85,
      ),
    outcome: is("unclassified", 0.5),
  },
  { match: /^credit rating/i, code: "credit_rating", outcome: is("credit_rating", 0.95) },
  { match: /^capacity addition|^commencement of (commercial )?production/i, code: "capex", outcome: is("capex", 0.9) },
  { match: /^bagging\/receiving of orders/i, code: "order_win", outcome: is("press_release", 0.75) },
  { match: /^monthly business updates/i, code: "business_update", outcome: is("press_release", 0.75) },
  { match: /^press release/i, code: "press_release", refine: (text) => promoteFromPressRelease(text), outcome: is("press_release", 0.8) },

  { match: /^pendency of litigation|litigation/i, code: "litigation", outcome: is("litigation", 0.9) },
  { match: /^action\(s\) taken or orders passed/i, code: "regulatory_action", outcome: is("litigation", 0.8) },
  {
    match: /key licenses|regulatory approvals/i,
    code: "license",
    refine: (text) => firstMatch(text, [[/withdraw|surrender|cancel|suspen|revok/i, "litigation", "license_withdrawn"]], 0.75),
    outcome: is("press_release", 0.65),
  },

  // Agreements: material only when the text says so.
  {
    match: /^agreements?/i,
    code: "agreements",
    refine: (text) => firstMatch(text, [[M_AND_A_RE, "m_and_a", "m_and_a"]], 0.75),
    outcome: is("unclassified", 0.45),
  },

  // Catch-all buckets that need the text.
  { match: /^general updates|^updates$|^others$|^disclosure of material issue|^amendment\(s\)|^committee meeting updates|^clarification/i, code: "generic", generic: true },
];

function promoteFromPressRelease(text: string): Outcome | null {
  const m = matchText(text, 0.75);
  if (!m || m.category === "press_release" || m.routine) return null;
  return m.category === "results" || m.category === "m_and_a" || m.category === "fund_raise" || m.category === "credit_rating" ? m : null;
}

interface Pin {
  code: string;
  category: Category;
  test: (subjectAndText: string, summary: string) => boolean;
}

const INSOLVENCY_RE = /corporate insolvency resolution|\bCIRP\b|insolvency (and bankruptcy|proceedings|petition)|resolution professional|interim resolution professional|liquidator appointed|under liquidation/i;
const DEFAULT_RE = /default (in|on) (the )?(payment|repayment)|delay(ed)? in (the )?(payment|repayment|servicing)|non-payment of (interest|principal)|defaulted (on|in)/i;
const FRAUD_RE = /\bfraud\b|forensic audit/i;
const AUDITOR_RE = /resignation of (the )?statutory auditors?|statutory auditors? (has|have) resigned/i;
const PENALTY_RE = /(penalty|fine) (of|amounting to|aggregating to) (rs\.?|inr|₹)|(imposed|levied) (a |monetary )?(penalty|fine)/i;
const REGULATOR_RE = /\b(SEBI|Securities and Exchange Board|RBI|Reserve Bank|IRDAI|adjudicating officer|adjudication order|whole time member)\b/i;

const PINS: Pin[] = [
  { code: "insolvency", category: "litigation", test: (st, summary) => INSOLVENCY_RE.test(st) || INSOLVENCY_RE.test(summary) },
  { code: "payment_default", category: "litigation", test: (st, summary) => DEFAULT_RE.test(st) || DEFAULT_RE.test(summary) },
  { code: "fraud", category: "litigation", test: (st) => FRAUD_RE.test(st) },
  { code: "auditor_resignation", category: "management_change", test: (st) => AUDITOR_RE.test(st) },
  {
    code: "regulatory_penalty",
    category: "litigation",
    test: (st, summary) => {
      const all = `${st}\n${summary}`;
      return PENALTY_RE.test(all) && REGULATOR_RE.test(all) && !/show cause/i.test(all);
    },
  },
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

export function classifyByRules(input: RuleClassificationInput): RuleClassification {
  const subject = (input.subject ?? "").trim();
  const text = (input.text ?? "").trim();
  const summary = (input.exchangeSummary ?? "").trim();

  let outcome: Outcome | null = null;
  const reasonCodes: string[] = [];

  const rule = SUBJECT_RULES.find((r) => r.match.test(subject));
  if (rule) {
    reasonCodes.push(`subject:${rule.code}`);
    outcome = rule.refine?.(text, summary) ?? (rule.outcome ? { ...rule.outcome, code: "" } : null);
    if (!outcome && rule.generic) outcome = matchText(text, 0.7) ?? matchText(summary, 0.55);
  } else {
    if (subject) reasonCodes.push(`subject_unknown:${slug(subject)}`);
    outcome = matchText(`${subject}\n${text}`, 0.65) ?? matchText(summary, 0.5);
  }

  let category: Category = outcome?.category ?? "unclassified";
  let confidence = outcome?.confidence ?? 0.3;
  if (outcome?.code) reasonCodes.push(outcome.code);
  if (outcome?.routine) reasonCodes.push(ROUTINE_REASON);

  const subjectAndText = `${subject}\n${text}`;
  const pin = PINS.find((p) => p.test(subjectAndText, summary));
  if (pin) {
    reasonCodes.push(`pin:${pin.code}`);
    if (category === "unclassified" || outcome?.routine) {
      category = pin.category;
      const idx = reasonCodes.indexOf(ROUTINE_REASON);
      if (idx >= 0) reasonCodes.splice(idx, 1);
    }
    confidence = Math.max(confidence, 0.8);
  }

  return { category, confidence, reasonCodes, pinned: pin ? "act" : null };
}
