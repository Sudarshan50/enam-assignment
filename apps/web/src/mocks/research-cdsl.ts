import type { Citation, Claim, ModuleKey, PromiseItem } from "@finn/shared";
import { CR } from "./util";

interface Doc {
  id: string;
  label: string;
  pages: number;
  url: string;
}

const IR = "https://www.cdslindia.com/InvestorRelations";

export const CDSL_DOCS: Doc[] = [
  { id: "doc-ar-fy25", label: "Annual Report FY25", pages: 284, url: `${IR}/AnnualReport-FY25.pdf` },
  { id: "doc-ar-fy26", label: "Annual Report FY26", pages: 298, url: `${IR}/AnnualReport-FY26.pdf` },
  { id: "doc-call-q3fy25", label: "Q3 FY25 earnings call", pages: 26, url: `${IR}/Transcript-Q3FY25.pdf` },
  { id: "doc-call-q4fy25", label: "Q4 FY25 earnings call", pages: 31, url: `${IR}/Transcript-Q4FY25.pdf` },
  { id: "doc-call-q1fy26", label: "Q1 FY26 earnings call", pages: 24, url: `${IR}/Transcript-Q1FY26.pdf` },
  { id: "doc-call-q2fy26", label: "Q2 FY26 earnings call", pages: 28, url: `${IR}/Transcript-Q2FY26.pdf` },
  { id: "doc-call-q3fy26", label: "Q3 FY26 earnings call", pages: 30, url: `${IR}/Transcript-Q3FY26.pdf` },
  { id: "doc-call-q4fy26", label: "Q4 FY26 earnings call", pages: 33, url: `${IR}/Transcript-Q4FY26.pdf` },
  { id: "doc-call-q1fy27", label: "Q1 FY27 earnings call", pages: 29, url: `${IR}/Transcript-Q1FY27.pdf` },
  { id: "doc-call-q2fy27", label: "Q2 FY27 earnings call", pages: 34, url: `${IR}/Transcript-Q2FY27.pdf` },
];

let chunkSeq = 0;
function cite(docId: string, page: number, quote: string): Citation {
  const doc = CDSL_DOCS.find((d) => d.id === docId)!;
  chunkSeq += 1;
  return { chunkId: `chk-${docId}-${page}-${chunkSeq}`, documentId: doc.id, documentLabel: doc.label, page, quote, url: `${doc.url}#page=${page}` };
}

function claim(text: string, citations: Citation[]): Claim {
  return { text, citations, grounded: citations.length > 0 };
}

const Q = {
  margin: "We should be able to hold operating margins in the 55 to 60 percent band through the first quarter, even as technology spend steps up.",
  doubleDigit: "Barring a sharp fall in market volumes, we expect to grow revenue in double digits year on year in the second quarter.",
  capex26: "Capex for the full year should be around ₹150 crore, mostly on the new data centre and the cyber-security stack.",
  pat26: "For the full year we are comfortable with profit growth in the mid-to-high teens.",
  accounts: "We expect new demat account additions to grow 20 percent plus this year.",
  rev27: "For FY27 we are looking at revenue growth of 15 to 20 percent on a normalised market.",
  capex27: "We have budgeted ₹120 to 140 crore of capex this year, including the spill-over from last year.",
  exit60: "Our aim is to exit FY27 with operating margins above 60 percent.",
  doubling: "Over five years we would like the non-depository businesses to be as large as the depository business itself.",
};

const P = (p: Omit<PromiseItem, "quote"> & { quote?: string }): PromiseItem => ({ quote: p.citation.quote, ...p });

export const CDSL_PROMISES: PromiseItem[] = [
  P({
    id: "pr-1",
    metric: "ebitda_margin",
    statementType: "explicit_guidance",
    low: 55,
    high: 60,
    unit: "pct",
    horizonLabel: "Q1 FY27",
    horizonEnd: "2026-06-30",
    saidIn: "Q4 FY26 call",
    speaker: "MD & CEO",
    citation: cite("doc-call-q4fy26", 7, Q.margin),
    actual: 57.2,
    actualPeriod: "Q1 FY27",
    actualSource: "NSE XBRL · Q1 FY27 consolidated",
    verdict: "delivered",
    explanation: "Q1 FY27 operating margin of 57.2% sits inside the guided 55–60% band.",
  }),
  P({
    id: "pr-2",
    metric: "revenue_growth",
    statementType: "explicit_guidance",
    low: 10,
    high: null,
    unit: "pct",
    horizonLabel: "Q2 FY27",
    horizonEnd: "2026-09-30",
    saidIn: "Q1 FY27 call",
    speaker: "CFO",
    citation: cite("doc-call-q1fy27", 6, Q.doubleDigit),
    actual: 18.4,
    actualPeriod: "Q2 FY27",
    actualSource: "NSE XBRL · Q2 FY27 vs Q2 FY26",
    verdict: "delivered",
    explanation: "Revenue grew 18.4% YoY in Q2 FY27, comfortably above the double-digit floor.",
  }),
  P({
    id: "pr-3",
    metric: "capex",
    statementType: "explicit_guidance",
    low: 150,
    high: 150,
    unit: "inr_crore",
    horizonLabel: "FY26",
    horizonEnd: "2026-03-31",
    saidIn: "Q3 FY26 call",
    speaker: "CFO",
    citation: cite("doc-call-q3fy26", 11, Q.capex26),
    actual: 96,
    actualPeriod: "FY26",
    actualSource: "Annual Report FY26 · cash-flow statement, p.112",
    verdict: "missed",
    explanation: "FY26 capex was ₹96 Cr — 36% short of the ~₹150 Cr guided, outside the ±10% tolerance. The annual report attributes it to the data-centre timeline slipping.",
  }),
  P({
    id: "pr-4",
    metric: "pat_growth",
    statementType: "explicit_guidance",
    low: 15,
    high: 19,
    unit: "pct",
    horizonLabel: "FY26",
    horizonEnd: "2026-03-31",
    saidIn: "Q3 FY26 call",
    speaker: "MD & CEO",
    citation: cite("doc-call-q3fy26", 5, Q.pat26),
    actual: 17.1,
    actualPeriod: "FY26",
    actualSource: "NSE XBRL · FY26 vs FY25 consolidated",
    verdict: "delivered",
    explanation: "FY26 PAT grew 17.1%, inside 'mid-to-high teens' (read as 15–19%).",
  }),
  P({
    id: "pr-5",
    metric: "volume_growth",
    statementType: "explicit_guidance",
    low: 20,
    high: null,
    unit: "pct",
    horizonLabel: "FY26",
    horizonEnd: "2026-03-31",
    saidIn: "Q3 FY26 call",
    speaker: "MD & CEO",
    citation: cite("doc-call-q3fy26", 4, Q.accounts),
    actual: 24,
    actualPeriod: "FY26",
    actualSource: "Annual Report FY26 · operating highlights, p.21",
    verdict: "delivered",
    explanation: "New demat accounts grew 24% in FY26, above the 20% floor.",
  }),
  P({
    id: "pr-8",
    metric: "ebitda_margin",
    statementType: "explicit_guidance",
    low: 60,
    high: null,
    unit: "pct",
    horizonLabel: "Exit FY27",
    horizonEnd: "2027-03-31",
    saidIn: "Q3 FY26 call",
    speaker: "MD & CEO",
    citation: cite("doc-call-q3fy26", 9, Q.exit60),
    actual: null,
    actualPeriod: null,
    actualSource: null,
    verdict: "quietly_dropped",
    explanation: "Stated once in the Q3 FY26 call, then neither repeated, revised nor withdrawn in the next three calls — while margins ran at 56–58%.",
  }),
  P({
    id: "pr-6",
    metric: "revenue_growth",
    statementType: "explicit_guidance",
    low: 15,
    high: 20,
    unit: "pct",
    horizonLabel: "FY27",
    horizonEnd: "2027-03-31",
    saidIn: "Q4 FY26 call",
    speaker: "CFO",
    citation: cite("doc-call-q4fy26", 8, Q.rev27),
    actual: null,
    actualPeriod: null,
    actualSource: null,
    verdict: "pending",
    explanation: "Horizon ends 31 Mar 2027. H1 FY27 revenue is up 19.2% YoY — tracking the top of the range, not yet judged.",
  }),
  P({
    id: "pr-7",
    metric: "capex",
    statementType: "explicit_guidance",
    low: 120,
    high: 140,
    unit: "inr_crore",
    horizonLabel: "FY27",
    horizonEnd: "2027-03-31",
    saidIn: "Q2 FY27 call",
    speaker: "CFO",
    citation: cite("doc-call-q2fy27", 12, Q.capex27),
    actual: null,
    actualPeriod: null,
    actualSource: null,
    verdict: "pending",
    explanation: "H1 FY27 capex was ₹58 Cr; the full-year horizon is still open.",
  }),
  P({
    id: "pr-9",
    metric: "revenue_growth",
    statementType: "aspiration",
    low: null,
    high: null,
    unit: "pct",
    horizonLabel: "FY31",
    horizonEnd: "2031-03-31",
    saidIn: "Q2 FY27 call",
    speaker: "MD & CEO",
    citation: cite("doc-call-q2fy27", 15, Q.doubling),
    actual: null,
    actualPeriod: null,
    actualSource: null,
    verdict: "not_scored",
    explanation: "An aspiration, not guidance — shown for context, never judged.",
  }),
];

export const CDSL_LEDGER = {
  summary: { elapsed: 5, delivered: 4, missed: 1, pending: 2, quietlyDropped: 1 },
  promises: CDSL_PROMISES,
  transcriptsUsed: ["Q3 FY26 call", "Q4 FY26 call", "Q1 FY27 call", "Q2 FY27 call"],
};

const SCREENER = "screener.in (secondary)";
const XBRL = "NSE XBRL";
const years = ["FY20", "FY21", "FY22", "FY23", "FY24", "FY25", "FY26"];
const series = (values: Array<number | null>, scale = 1) =>
  values.map((v, i) => ({ period: years[i]!, value: v == null ? null : v * scale }));

export const CDSL_FINANCIALS = {
  headline: [
    { label: "Revenue · TTM", value: 1351.4 * CR, unit: "inr", period: "Q2 FY27", source: XBRL },
    { label: "Operating margin", value: 57.6, unit: "pct", period: "Q2 FY27", source: XBRL },
    { label: "PAT · TTM", value: 605 * CR, unit: "inr", period: "Q2 FY27", source: XBRL },
    { label: "Return on equity", value: 31.2, unit: "pct", period: "FY26", source: SCREENER },
  ],
  series: [
    { key: "revenue", label: "Revenue", unit: "inr", source: SCREENER, points: series([222, 344, 551, 555, 812, 1082, 1240], CR) },
    { key: "pat", label: "PAT", unit: "inr", source: SCREENER, points: series([106, 201, 312, 276, 420, 485, 568], CR) },
    { key: "op_margin", label: "Operating margin", unit: "pct", source: SCREENER, points: series([52.1, 63.4, 66.1, 59.0, 60.8, 61.5, 57.9]) },
    {
      key: "revenue_q",
      label: "Quarterly revenue",
      unit: "inr",
      source: XBRL,
      points: [
        { period: "Q1 FY26", value: 278 * CR },
        { period: "Q2 FY26", value: 301 * CR },
        { period: "Q3 FY26", value: 318 * CR },
        { period: "Q4 FY26", value: 343 * CR },
        { period: "Q1 FY27", value: 334 * CR },
        { period: "Q2 FY27", value: 356.4 * CR },
      ],
    },
  ],
  takeaways: [
    claim("Revenue grew about 5.6× in six years, from ₹222 Cr in FY20 to ₹1,240 Cr in FY26.", [
      cite("doc-ar-fy26", 48, "Total revenue from operations for the year stood at ₹1,240.2 crore."),
    ]),
    claim("Operating margin has slipped from the FY22 peak of 66% to 58% as technology and regulatory spend rose.", [
      cite("doc-call-q2fy27", 9, "Technology and cyber-security costs will remain elevated as we scale, and we are comfortable absorbing that."),
    ]),
  ],
};

export const CDSL_CASH = {
  periods: [
    { period: "H1 FY26", cfo: 248 * CR, pat: 265 * CR, cashConversion: 0.94, capex: 41 * CR, fcf: 207 * CR, debtToEquity: 0, note: null },
    { period: "FY26", cfo: 602 * CR, pat: 568 * CR, cashConversion: 1.06, capex: 96 * CR, fcf: 506 * CR, debtToEquity: 0, note: null },
    {
      period: "H1 FY27",
      cfo: 281 * CR,
      pat: 302 * CR,
      cashConversion: 0.93,
      capex: 58 * CR,
      fcf: 223 * CR,
      debtToEquity: 0,
      note: "Excludes clearing-member margin balances held in trust (AR FY26, note 14).",
    },
  ],
  takeaways: [
    claim("Profits turn into cash: FY26 cash from operations of ₹602 Cr exceeded PAT of ₹568 Cr.", [
      cite("doc-ar-fy26", 112, "Net cash generated from operating activities 602.4"),
    ]),
    claim("The company carries no borrowings.", [cite("doc-ar-fy26", 104, "The Company has no borrowings as at March 31, 2026.")]),
  ],
};

export const CDSL_BUSINESS = {
  description: claim(
    "CDSL is one of India's two securities depositories. It holds shares in electronic form for investors through depository participants, and earns fees from issuers, transactions, IPOs and KYC data services.",
    [cite("doc-ar-fy26", 12, "CDSL provides depository services to investors through its network of depository participants, and offers KYC and e-voting services through its subsidiaries.")],
  ),
  segments: [
    { name: "Transaction charges", sharePct: 27, claim: claim("Transaction charges were 27% of FY26 revenue.", [cite("doc-ar-fy26", 53, "Transaction charges 27%")]) },
    { name: "Annual issuer charges", sharePct: 24, claim: claim("Annual issuer charges were 24%.", [cite("doc-ar-fy26", 53, "Annual issuer charges 24%")]) },
    { name: "Online data (KYC)", sharePct: 21, claim: claim("Online data charges, mainly KYC, were 21%.", [cite("doc-ar-fy26", 53, "Online data charges 21%")]) },
    { name: "IPO & corporate actions", sharePct: 13, claim: claim("IPO and corporate-action charges were 13%.", [cite("doc-ar-fy26", 53, "IPO / corporate action charges 13%")]) },
    { name: "Other", sharePct: 15, claim: claim("Other income streams, including e-voting, made up 15%.", [cite("doc-ar-fy26", 53, "Others 15%")]) },
  ],
};

export const CDSL_BULL_BEAR = {
  bull: [
    claim("Every new demat account becomes a recurring fee: accounts grew 24% in FY26, and issuers pay annual charges on every folio.", [
      cite("doc-ar-fy26", 21, "New BO accounts opened during the year grew 24% over the previous year."),
      cite("doc-call-q4fy26", 4, "Annual issuer charges scale with the number of folios, not with trading activity."),
    ]),
    claim("KYC and e-voting diversify revenue away from market volumes — online data charges were 21% of FY26 revenue.", [
      cite("doc-ar-fy26", 53, "Online data charges 21%"),
    ]),
    claim("Debt-free, with FY26 cash from operations of ₹602 Cr against capex of ₹96 Cr.", [
      cite("doc-ar-fy26", 112, "Net cash generated from operating activities 602.4"),
    ]),
  ],
  bear: [
    claim("Transaction revenue rides market activity; management itself names a sharp fall in volumes as the main risk to growth.", [
      cite("doc-call-q1fy27", 6, "Barring a sharp fall in market volumes, we expect to grow revenue in double digits year on year"),
    ]),
    claim("Margins have compressed for two years as technology and regulatory spend rises, and management expects that to continue.", [
      cite("doc-call-q2fy27", 9, "Technology and cyber-security costs will remain elevated as we scale"),
    ]),
    claim("A regulatory cap on depository fees could compress pricing across the board.", []),
  ],
};

export const CDSL_PAYLOADS: Record<ModuleKey, unknown> = {
  promise_ledger: CDSL_LEDGER,
  financial_snapshot: CDSL_FINANCIALS,
  cash_quality: CDSL_CASH,
  business_snapshot: CDSL_BUSINESS,
  bull_bear: CDSL_BULL_BEAR,
};

export const CDSL_ASK_ANSWERS: Array<{ match: RegExp; answer: Claim[] }> = [
  {
    match: /margin|profitab/i,
    answer: [
      claim("Management guided a 55–60% operating-margin band for Q1 FY27 and delivered 57.2%.", [cite("doc-call-q4fy26", 7, Q.margin)]),
      claim("It expects technology and cyber-security costs to stay elevated, which caps near-term expansion.", [
        cite("doc-call-q2fy27", 9, "Technology and cyber-security costs will remain elevated as we scale"),
      ]),
      claim("The earlier aim of exiting FY27 above 60% has not been repeated since the Q3 FY26 call.", [cite("doc-call-q3fy26", 9, Q.exit60)]),
    ],
  },
  {
    match: /capex|data cent|spend/i,
    answer: [
      claim("FY26 capex was ₹96 Cr against roughly ₹150 Cr guided, because the data-centre build slipped.", [
        cite("doc-ar-fy26", 112, "Purchase of property, plant and equipment and intangible assets (96.1)"),
        cite("doc-call-q3fy26", 11, Q.capex26),
      ]),
      claim("For FY27 the budget is ₹120–140 Cr, including spill-over from last year.", [cite("doc-call-q2fy27", 12, Q.capex27)]),
    ],
  },
];

export const CDSL_DEFAULT_ANSWER: Claim[] = [
  claim("Growth is guided at 15–20% for FY27 on a normalised market, and H1 is running at about 19%.", [cite("doc-call-q4fy26", 8, Q.rev27)]),
  claim("The main risk management names is a sharp fall in market volumes.", [
    cite("doc-call-q1fy27", 6, "Barring a sharp fall in market volumes, we expect to grow revenue in double digits"),
  ]),
  claim("Whether new fee lines will offset a volume slowdown is not addressed in the transcripts.", []),
];
