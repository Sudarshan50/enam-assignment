import { pctChange, type Card, type DigestItem, type DigestResponse, type ResultsMetric, type SourceHealth } from "@finn/shared";
import { CR, hoursAgo, minutesAgo } from "./util";

export type DigestWindow = "24h" | "3d" | "7d";
export type MockScenario = "default" | "stale" | "caughtup";

const WINDOW_HOURS: Record<DigestWindow, number> = { "24h": 24, "3d": 72, "7d": 168 };

const EBITDA_DEFINITION =
  "FINN EBITDA = profit before exceptional items and tax + finance costs + depreciation & amortisation − other income. Computed from the XBRL filing; the company does not report it.";

function pdf(symbol: string, id: string): string {
  return `https://nsearchives.nseindia.com/corporate/${symbol}_${id}.pdf`;
}

function metric(
  key: string,
  label: string,
  [cur, prev, yearAgo]: [number, number, number],
  ref: string,
  derived = false,
): ResultsMetric {
  const num = (crore: number) => ({ value: crore * CR, unit: "inr" as const, derived, source: { kind: "xbrl" as const, ref } });
  return {
    key,
    label,
    current: num(cur),
    previousQuarter: num(prev),
    yearAgoQuarter: num(yearAgo),
    qoqPct: pctChange(cur, prev),
    yoyPct: pctChange(cur, yearAgo),
  };
}

// TCS consolidated XBRL, OneD context: Q2 FY27 / Q1 FY27 / Q2 FY26, ₹ crore.
const TCS = {
  revenue: [73188, 72275, 65799] as [number, number, number],
  ebitda: [18638 + 252 + 1262 - 1337, 18612 + 273 + 1239 - 1568, 17203 + 229 + 1413 - 867] as [number, number, number],
  pbt: [18638, 17944, 16068] as [number, number, number],
  pat: [13934, 13420, 12131] as [number, number, number],
};
const tcsMargin = TCS.ebitda.map((e, i) => (e / TCS.revenue[i]!) * 100);

const tcsResults: Card = {
  kind: "results",
  periodEnd: "2026-09-30",
  periodLabel: "Q2 FY27",
  basis: "consolidated",
  statementFamily: "industrial",
  audited: false,
  status: "ready",
  metrics: [
    metric("revenue", "Revenue", TCS.revenue, "TCS_30-SEP-2026_consolidated.xml"),
    metric("ebitda", "EBITDA", TCS.ebitda, "TCS_30-SEP-2026_consolidated.xml", true),
    metric("pbt", "PBT", TCS.pbt, "TCS_30-SEP-2026_consolidated.xml"),
    metric("pat", "PAT", TCS.pat, "TCS_30-SEP-2026_consolidated.xml"),
  ],
  marginBps: {
    label: "EBITDA margin",
    current: tcsMargin[0]!,
    qoqBps: Math.round((tcsMargin[0]! - tcsMargin[1]!) * 100),
    yoyBps: Math.round((tcsMargin[0]! - tcsMargin[2]!) * 100),
  },
  read: "Revenue grew 11.2% YoY, but EBITDA margin gave back 161 bps. PAT growth of 14.9% is flattered by a ₹1,135 Cr exceptional charge in the year-ago quarter.",
  ebitdaDefinition: EBITDA_DEFINITION,
};

// HDFC Bank consolidated XBRL (banking taxonomy): NII = interest earned − interest expended.
const HDFC = {
  nii: [95131.6 - 50667.4, 90575.3 - 47625.6, 86993.8 - 46740.9] as [number, number, number],
  ppop: [32871.5, 30996.0, 30940.7] as [number, number, number],
  pbt: [27825.5, 27193.2, 25905.8] as [number, number, number],
  pat: [20700.0, 20382.7, 19610.7] as [number, number, number],
};

const hdfcResults: Card = {
  kind: "results",
  periodEnd: "2026-09-30",
  periodLabel: "Q2 FY27",
  basis: "consolidated",
  statementFamily: "banking",
  audited: false,
  status: "ready",
  metrics: [
    metric("nii", "NII", HDFC.nii, "HDFCBANK_30-SEP-2026_consolidated.xml", true),
    metric("ppop", "PPOP", HDFC.ppop, "HDFCBANK_30-SEP-2026_consolidated.xml"),
    metric("pbt", "PBT", HDFC.pbt, "HDFCBANK_30-SEP-2026_consolidated.xml"),
    metric("pat", "PAT", HDFC.pat, "HDFCBANK_30-SEP-2026_consolidated.xml"),
  ],
  marginBps: null,
  read: "Core income held up: NII +10.5% YoY and PPOP +6.2%. Provisions eased to ₹4,209 Cr from ₹4,282 Cr a year ago, so PAT rose 5.6%.",
  ebitdaDefinition: null,
};

const trentPending: Card = {
  kind: "results",
  periodEnd: "2026-09-30",
  periodLabel: "Q2 FY27",
  basis: "consolidated",
  statementFamily: "industrial",
  audited: false,
  status: "not_filed_yet",
  metrics: [],
  marginBps: null,
  read: null,
  ebitdaDefinition: null,
};

type Seed = Omit<DigestItem, "publishedAt" | "linked" | "pdfUrl"> & {
  hours: number;
  linked?: Array<{ headline: string; hours: number }>;
  hasPdf?: boolean;
};

const SEEDS: Seed[] = [
  {
    id: "2026111500412",
    symbol: "TRENT",
    companyName: "Trent",
    category: "results",
    tier: "act",
    score: 84,
    reasonCodes: ["results", "board_approved_today", "xbrl_pending"],
    headline: "Board approves Q2 FY27 results",
    oneLiner: "The board signed off at 16:10 IST. Line items arrive with the XBRL filing, usually within a few hours.",
    card: trentPending,
    hours: 2.2,
  },
  {
    id: "2026111500388",
    symbol: "TCS",
    companyName: "Tata Consultancy Services",
    category: "results",
    tier: "act",
    score: 88,
    reasonCodes: ["results", "margin_yoy_-161bps", "pat_yoy_+14.9%", "volume_2.4x"],
    headline: "Q2 FY27 results: revenue ₹73,188 Cr, PAT ₹13,934 Cr",
    oneLiner: "Double-digit growth with thinner margins; the PAT jump leans on a weak, charge-hit base.",
    card: tcsResults,
    hours: 5.4,
    linked: [
      { headline: "Outcome of board meeting", hours: 5.5 },
      { headline: "Press release — Q2 FY27 performance", hours: 5.3 },
      { headline: "Newspaper publication of results", hours: 4.1 },
    ],
  },
  {
    id: "2026111400951",
    symbol: "HDFCBANK",
    companyName: "HDFC Bank",
    category: "results",
    tier: "act",
    score: 82,
    reasonCodes: ["results", "nii_yoy_+10.5%", "provisions_down"],
    headline: "Q2 FY27 results: NII ₹44,464 Cr, PAT ₹20,700 Cr",
    oneLiner: "Steady core earnings; credit costs eased slightly year on year.",
    card: hdfcResults,
    hours: 19.6,
    linked: [{ headline: "Investor presentation — Q2 FY27", hours: 19.2 }],
  },
  {
    id: "2026111300217",
    symbol: "BAJFINANCE",
    companyName: "Bajaj Finance",
    category: "management_change",
    tier: "act",
    score: 79,
    reasonCodes: ["cxo_change", "cfo", "effective_in_16_days"],
    headline: "Appoints Rohan Mehta as Chief Financial Officer",
    oneLiner: "Outgoing CFO retires on superannuation; the incoming CFO joins from a large bank's retail-assets business.",
    card: {
      kind: "management_change",
      seniority: "board_or_cxo",
      summary: "A planned CFO succession, announced with a two-week handover.",
      people: [
        {
          name: "Rohan Mehta",
          role: "Chief Financial Officer",
          direction: "incoming",
          effectiveDate: "2026-12-01",
          reason: null,
          filingProfile:
            "Chartered accountant with 22 years in consumer lending. Most recently CFO of a large private-sector bank's retail-assets business, where he ran treasury, asset-liability management and investor relations. Earlier spent 11 years at a multinational NBFC across risk and finance.",
          profilePage: 3,
          link: null,
        },
        {
          name: "Vikram Desai",
          role: "Chief Financial Officer",
          direction: "outgoing",
          effectiveDate: "2026-11-30",
          reason: "Retirement on superannuation",
          filingProfile: null,
          profilePage: null,
          link: null,
        },
      ],
    },
    hours: 31,
  },

  {
    id: "2026111500133",
    symbol: "BHARTIARTL",
    companyName: "Bharti Airtel",
    category: "credit_rating",
    tier: "know",
    score: 63,
    reasonCodes: ["upgrade", "long_term_rating"],
    headline: "CRISIL upgrades long-term rating to AAA",
    oneLiner: "One notch up from AA+, outlook Stable, citing lower leverage after recent tariff increases.",
    card: {
      kind: "credit_rating",
      agency: "CRISIL Ratings",
      instrument: "Long-term bank facilities and NCDs",
      previousRating: "AA+",
      newRating: "AAA",
      outlook: "Stable",
      action: "upgrade",
    },
    hours: 8.2,
  },
  {
    id: "2026111400702",
    symbol: "LT",
    companyName: "Larsen & Toubro",
    category: "m_and_a",
    tier: "know",
    score: 57,
    reasonCodes: ["joint_venture", "size_0.06%_mcap"],
    headline: "Forms green-hydrogen electrolyser joint venture",
    oneLiner: "L&T will hold 74% of the JV and invest up to ₹340 Cr over three years — small against its balance sheet.",
    card: {
      kind: "deal",
      dealType: "joint_venture",
      counterparty: "Electrolyser technology partner (26%)",
      amountInr: { value: 340 * CR, unit: "inr", derived: false, source: { kind: "filing_pdf", ref: "LT_JV_disclosure.pdf", page: 2 } },
      pctOfMarketCap: 0.06,
      rationale: "Local manufacturing of pressurised alkaline electrolysers for L&T's own green-hydrogen EPC pipeline.",
    },
    hours: 40,
  },
  {
    id: "2026111300488",
    symbol: "DIXON",
    companyName: "Dixon Technologies (India)",
    category: "litigation",
    tier: "know",
    score: 61,
    reasonCodes: ["tax_demand", "4.1%_of_net_worth"],
    headline: "Receives income-tax demand of ₹212 Cr for AY 2022-23",
    oneLiner: "The company says it will appeal and does not expect a material impact.",
    card: {
      kind: "litigation",
      authority: "Income Tax Department, Assessment Unit",
      amountInr: { value: 212 * CR, unit: "inr", derived: false, source: { kind: "filing_pdf", ref: "DIXON_tax_order.pdf", page: 1 } },
      pctOfNetWorth: 4.1,
      summary: "Draft assessment order disallowing certain component-import credits. Dixon will file objections with the Dispute Resolution Panel.",
    },
    hours: 50,
  },
  {
    id: "2026111200314",
    symbol: "ITC",
    companyName: "ITC",
    category: "dividend",
    tier: "know",
    score: 41,
    reasonCodes: ["interim_dividend", "record_date_set"],
    headline: "Declares interim dividend of ₹6.50 per share",
    oneLiner: null,
    card: { kind: "corporate_action", action: "dividend", amountPerShare: 6.5, ratio: null, recordDate: "2026-11-20", yieldPct: 1.58 },
    hours: 60,
  },
  {
    id: "2026111100620",
    symbol: "TITAN",
    companyName: "Titan Company",
    category: "insider_trading",
    tier: "know",
    score: 52,
    reasonCodes: ["promoter_group", "sell"],
    headline: "Promoter-group entity sells 12.5 lakh shares",
    oneLiner: "Holding slips 14 bps to 52.76%; disclosed under SEBI insider-trading rules.",
    card: { kind: "ownership", action: "insider_sell", person: "Promoter-group trust", shares: 1_250_000, holdingPctBefore: 52.9, holdingPctAfter: 52.76 },
    hours: 90,
  },
  {
    id: "2026111000207",
    symbol: "POLYCAB",
    companyName: "Polycab India",
    category: "capex",
    tier: "know",
    score: 49,
    reasonCodes: ["capex", "1.1%_mcap"],
    headline: "Board approves ₹1,200 Cr extra-high-voltage cable plant",
    oneLiner: "Commissioning targeted for FY29, funded from internal accruals.",
    card: {
      kind: "deal",
      dealType: "capex",
      counterparty: null,
      amountInr: { value: 1200 * CR, unit: "inr", derived: false, source: { kind: "filing_pdf", ref: "POLYCAB_capex.pdf", page: 1 } },
      pctOfMarketCap: 1.08,
      rationale: "Adds EHV capacity in Gujarat ahead of transmission-grid tenders.",
    },
    hours: 110,
  },
  {
    id: "2026110900155",
    symbol: "RELIANCE",
    companyName: "Reliance Industries",
    category: "fund_raise",
    tier: "know",
    score: 55,
    reasonCodes: ["debt", "ncd_private_placement"],
    headline: "Raises ₹10,000 Cr through 10-year NCDs",
    oneLiner: "Private placement at 7.12%; proceeds to refinance existing borrowings.",
    card: {
      kind: "deal",
      dealType: "fund_raise",
      counterparty: null,
      amountInr: { value: 10000 * CR, unit: "inr", derived: false, source: { kind: "filing_pdf", ref: "RELIANCE_ncd.pdf", page: 1 } },
      pctOfMarketCap: 0.49,
      rationale: "Refinancing; no change to net debt.",
    },
    hours: 130,
  },

  {
    id: "2026111500097",
    symbol: "INFY",
    companyName: "Infosys",
    category: "unclassified",
    tier: "noise",
    score: 14,
    reasonCodes: ["esop_allotment"],
    headline: "Allotment of 41,820 shares under ESOP scheme",
    oneLiner: null,
    card: { kind: "generic", oneLiner: "Routine employee stock allotment; dilution is negligible." },
    hours: 3.1,
  },
  {
    id: "2026111500061",
    symbol: "ICICIBANK",
    companyName: "ICICI Bank",
    category: "investor_meetings",
    tier: "noise",
    score: 19,
    reasonCodes: ["investor_meet_schedule"],
    headline: "Schedule of analyst and institutional investor meetings",
    oneLiner: null,
    card: null,
    hours: 10.3,
  },
  {
    id: "2026111400844",
    symbol: "PERSISTENT",
    companyName: "Persistent Systems",
    category: "unclassified",
    tier: "noise",
    score: 12,
    reasonCodes: ["compliance_certificate"],
    headline: "Compliance certificate under Regulation 74(5)",
    oneLiner: null,
    card: null,
    hours: 14.6,
  },
  {
    id: "2026111300533",
    symbol: "MARUTI",
    companyName: "Maruti Suzuki India",
    category: "postal_ballot",
    tier: "noise",
    score: 24,
    reasonCodes: ["postal_ballot_result"],
    headline: "Results of postal ballot — all resolutions passed",
    oneLiner: null,
    card: null,
    hours: 45,
  },
  {
    id: "2026111300190",
    symbol: "SUNPHARMA",
    companyName: "Sun Pharmaceutical Industries",
    category: "earnings_call",
    tier: "noise",
    score: 29,
    reasonCodes: ["call_recording"],
    headline: "Audio recording of Q2 FY27 earnings call",
    oneLiner: null,
    card: null,
    hours: 55,
  },
  {
    id: "2026111100410",
    symbol: "ETERNAL",
    companyName: "Eternal",
    category: "unclassified",
    tier: "noise",
    score: 11,
    reasonCodes: ["trading_window"],
    headline: "Closure of trading window",
    oneLiner: null,
    card: null,
    hours: 100,
  },
  {
    id: "2026110800071",
    symbol: "ADANIPORTS",
    companyName: "Adani Ports and Special Economic Zone",
    category: "unclassified",
    tier: "noise",
    score: 10,
    reasonCodes: ["share_certificate_loss"],
    headline: "Newspaper notice: loss of share certificates",
    oneLiner: null,
    card: null,
    hours: 150,
  },
];

function toItem(seed: Seed, now: Date): DigestItem {
  const { hours, linked, hasPdf = true, ...rest } = seed;
  return {
    ...rest,
    publishedAt: hoursAgo(now, hours),
    pdfUrl: hasPdf ? pdf(seed.symbol, seed.id) : null,
    linked: (linked ?? []).map((l, i) => ({
      seqId: `${seed.id}-${i + 1}`,
      headline: l.headline,
      pdfUrl: pdf(seed.symbol, `${seed.id}-${i + 1}`),
      publishedAt: hoursAgo(now, l.hours),
    })),
  };
}

export function allMockItems(now: Date): DigestItem[] {
  return SEEDS.map((s) => toItem(s, now));
}

export function buildSourceHealth(now: Date, scenario: MockScenario): SourceHealth[] {
  const stale = scenario === "stale";
  return [
    {
      source: "nse_announcements",
      lastSuccessAt: stale ? hoursAgo(now, 6.5) : minutesAgo(now, 11),
      lastAttemptAt: minutesAgo(now, stale ? 4 : 11),
      consecutiveFailures: stale ? 9 : 0,
      lastError: stale ? "NSE returned an HTML challenge page instead of JSON" : null,
      stale,
    },
    {
      source: "nse_integrated_filings",
      lastSuccessAt: minutesAgo(now, 26),
      lastAttemptAt: minutesAgo(now, 26),
      consecutiveFailures: 0,
      lastError: null,
      stale: false,
    },
    {
      source: "nse_bhavcopy",
      lastSuccessAt: hoursAgo(now, 40),
      lastAttemptAt: hoursAgo(now, 40),
      consecutiveFailures: 0,
      lastError: null,
      stale: false,
    },
    {
      source: "screener_documents",
      lastSuccessAt: hoursAgo(now, 20),
      lastAttemptAt: hoursAgo(now, 20),
      consecutiveFailures: 1,
      lastError: "Timeout fetching one annual-report link; retried next run",
      stale: false,
    },
  ];
}

export function buildDigest(now: Date, window: DigestWindow, scenario: MockScenario): DigestResponse {
  const from = new Date(now.getTime() - WINDOW_HOURS[window] * 3_600_000);
  let items = SEEDS.filter((s) => s.hours <= WINDOW_HOURS[window]).map((s) => toItem(s, now));
  if (scenario === "caughtup") items = items.filter((i) => i.tier === "noise").slice(0, 2);
  const byScore = (a: DigestItem, b: DigestItem) => b.score - a.score;
  const act = items.filter((i) => i.tier === "act").sort(byScore);
  const know = items.filter((i) => i.tier === "know").sort(byScore);
  const noise = items.filter((i) => i.tier === "noise").sort(byScore);
  const sourceHealth = buildSourceHealth(now, scenario);
  return {
    window: { from: from.toISOString(), to: now.toISOString() },
    asOf: scenario === "stale" ? hoursAgo(now, 6.5) : minutesAgo(now, 11),
    caughtUp: scenario !== "stale",
    counts: { act: act.length, know: know.length, noise: noise.length },
    act,
    know,
    noise,
    sourceHealth,
  };
}
