/**
 * Dev-only demo data so the web app has something to show before the worker has ingested anything.
 * Every row is tagged so it can be wiped without touching real data:
 *   announcements / quarterly_filings  seq_id LIKE 'DEMO-%'
 *   prices_eod                          source = 'demo' (real bhavcopy rows always win on conflict)
 *   alerts                              event_key LIKE 'demo:%'
 *   research_runs                       requested_by = 'demo-data' (events/modules cascade)
 *   documents                           url LIKE 'demo://%' (chunks/guidance cascade)
 *
 * Usage (idempotent: wipes demo rows, then re-inserts):
 *   npm run demo-data -w @finn/api            # seed
 *   npm run demo-data -w @finn/api -- --wipe  # remove demo rows only
 */
import { type Sql, closeDb, getDb } from "@finn/db";
import {
  BullBearPayloadSchema,
  type Card,
  CardSchema,
  CashQualityPayloadSchema,
  FinancialSnapshotPayloadSchema,
  PromiseLedgerPayloadSchema,
  type ResultsMetric,
  istDateString,
  pctChange,
} from "@finn/shared";

export const DEMO = {
  seqPrefix: "DEMO-",
  priceSource: "demo",
  alertKeyPrefix: "demo:",
  requestedBy: "demo-data",
  docUrlPrefix: "demo://",
} as const;

const CRORE = 1e7;
const HOUR = 3_600_000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const PRICE_SESSIONS = 45;

type Json = Parameters<Sql["json"]>[0];
const asJson = (v: unknown) => v as Json;

export async function wipeDemoData(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM alerts WHERE event_key LIKE ${`${DEMO.alertKeyPrefix}%`}`;
    await tx`DELETE FROM research_runs WHERE requested_by = ${DEMO.requestedBy}`;
    await tx`DELETE FROM documents WHERE url LIKE ${`${DEMO.docUrlPrefix}%`}`;
    await tx`UPDATE announcements SET parent_seq_id = NULL WHERE parent_seq_id LIKE ${`${DEMO.seqPrefix}%`}`;
    await tx`DELETE FROM announcements WHERE seq_id LIKE ${`${DEMO.seqPrefix}%`}`;
    await tx`DELETE FROM quarterly_filings WHERE seq_id LIKE ${`${DEMO.seqPrefix}%`}`;
    await tx`DELETE FROM prices_eod WHERE source = ${DEMO.priceSource}`;
  });
}

// ---------- prices ----------

const BASE: Record<string, { price: number; volume: number }> = {
  RELIANCE: { price: 1450, volume: 9e6 },
  HDFCBANK: { price: 990, volume: 14e6 },
  ICICIBANK: { price: 1400, volume: 11e6 },
  TCS: { price: 3100, volume: 2.5e6 },
  INFY: { price: 1500, volume: 6e6 },
  BHARTIARTL: { price: 2050, volume: 5e6 },
  ITC: { price: 410, volume: 12e6 },
  LT: { price: 3900, volume: 2e6 },
  SUNPHARMA: { price: 1750, volume: 2e6 },
  TITAN: { price: 3700, volume: 1.2e6 },
  BAJFINANCE: { price: 1000, volume: 5e6 },
  MARUTI: { price: 16000, volume: 0.4e6 },
  TRENT: { price: 4300, volume: 0.9e6 },
  ETERNAL: { price: 310, volume: 40e6 },
  DIXON: { price: 15500, volume: 0.35e6 },
  POLYCAB: { price: 7400, volume: 0.5e6 },
  PERSISTENT: { price: 6000, volume: 0.6e6 },
  ADANIPORTS: { price: 1450, volume: 3e6 },
};

/** Return override (fraction) or volume multiple on a session counted back from the latest (0 = latest). */
const SHOCKS: Record<string, { back: number; ret?: number; volumeX?: number }[]> = {
  TRENT: [{ back: 0, ret: -0.062, volumeX: 2.4 }],
  DIXON: [{ back: 0, ret: 0.021, volumeX: 3.4 }],
  ITC: [{ back: 7, ret: 0.053 }],
  POLYCAB: [{ back: 12, volumeX: 2.6 }],
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** The latest `count` weekday session dates (IST), counting today only after the 18:00 bhavcopy. */
export function recentSessions(now: Date, count: number): string[] {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const cursor = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  if (ist.getUTCHours() < 18) cursor.setUTCDate(cursor.getUTCDate() - 1);
  const out: string[] = [];
  while (out.length < count) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out.reverse();
}

interface PriceRow {
  symbol: string;
  session_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prev_close: number;
  volume: number;
  avg20_volume: number | null;
  source: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildPrices(symbol: string, sessions: string[]): PriceRow[] {
  const base = BASE[symbol] ?? { price: 1000, volume: 1e6 };
  const rand = mulberry32(hash(symbol));
  const shocks = SHOCKS[symbol] ?? [];
  const rows: PriceRow[] = [];
  let prev = base.price * (0.94 + rand() * 0.06);
  sessions.forEach((date, i) => {
    const back = sessions.length - 1 - i;
    const shock = shocks.find((s) => s.back === back);
    const ret = shock?.ret ?? (rand() - 0.5) * 0.026;
    const close = r2(prev * (1 + ret));
    const open = r2(prev * (1 + (rand() - 0.5) * 0.008));
    const high = r2(Math.max(open, close) * (1 + rand() * 0.006));
    const low = r2(Math.min(open, close) * (1 - rand() * 0.006));
    const volume = Math.round(base.volume * (0.7 + rand() * 0.6) * (shock?.volumeX ?? 1));
    const window = rows.slice(-20);
    const avg20 = window.length === 20 ? Math.round(window.reduce((s, r) => s + r.volume, 0) / 20) : null;
    rows.push({ symbol, session_date: date, open, high, low, close, prev_close: r2(prev), volume, avg20_volume: avg20, source: DEMO.priceSource });
    prev = close;
  });
  return rows;
}

// ---------- cards ----------

function resultsMetric(key: string, label: string, cur: number, prev: number, yearAgo: number, ref: string, derived = false): ResultsMetric {
  const n = (crore: number, r: string) => ({ value: crore * CRORE, unit: "inr" as const, derived, source: { kind: "xbrl" as const, ref: r } });
  const pct = (a: number, b: number) => {
    const v = pctChange(a, b);
    return v === null ? null : Math.round(v * 10) / 10;
  };
  return {
    key,
    label,
    current: n(cur, ref),
    previousQuarter: n(prev, "DEMO-QF-TCS-Q1FY27"),
    yearAgoQuarter: n(yearAgo, "DEMO-QF-TCS-Q2FY26"),
    qoqPct: pct(cur, prev),
    yoyPct: pct(cur, yearAgo),
  };
}

const TCS_Q = {
  q2fy27: { revenue: 73188, ebitda: 19950, pat: 13420 },
  q1fy27: { revenue: 72275, ebitda: 19420, pat: 13110 },
  q2fy26: { revenue: 65799, ebitda: 17980, pat: 12075 },
};

function tcsResultsCard(): Card {
  const { q2fy27: c, q1fy27: p, q2fy26: y } = TCS_Q;
  const margin = (q: { revenue: number; ebitda: number }) => (q.ebitda / q.revenue) * 100;
  const bps = (a: number, b: number) => Math.round((a - b) * 100);
  return CardSchema.parse({
    kind: "results",
    periodEnd: "2026-09-30",
    periodLabel: "Q2 FY27",
    basis: "consolidated",
    statementFamily: "industrial",
    audited: false,
    status: "ready",
    metrics: [
      resultsMetric("revenue", "Revenue", c.revenue, p.revenue, y.revenue, "DEMO-QF-TCS-Q2FY27"),
      resultsMetric("ebitda", "EBITDA (computed)", c.ebitda, p.ebitda, y.ebitda, "DEMO-QF-TCS-Q2FY27", true),
      resultsMetric("pat", "PAT", c.pat, p.pat, y.pat, "DEMO-QF-TCS-Q2FY27"),
    ],
    marginBps: {
      label: "EBITDA margin",
      current: Math.round(margin(c) * 100) / 100,
      qoqBps: bps(margin(c), margin(p)),
      yoyBps: bps(margin(c), margin(y)),
    },
    read: "Demo data: revenue up 1.3% QoQ with margins slightly better; numbers are illustrative.",
    ebitdaDefinition: "Profit before exceptional items and tax + finance costs + depreciation - other income",
  });
}

interface DemoAnnouncement {
  seqId: string;
  symbol: string;
  headline: string;
  hoursAgo: number;
  category: string;
  score: number;
  tier: "act" | "know" | "noise";
  reasonCodes: string[];
  oneLiner: string;
  card: Card | null;
  parent?: string;
  clusterKey?: string;
}

function demoAnnouncements(): DemoAnnouncement[] {
  const generic = (oneLiner: string): Card => CardSchema.parse({ kind: "generic", oneLiner });
  return [
    {
      seqId: "DEMO-TCS-RESULTS",
      symbol: "TCS",
      headline: "[Demo] Financial Results for the quarter ended 30-Sep-2026",
      hoursAgo: 3,
      category: "results",
      score: 84,
      tier: "act",
      reasonCodes: ["category:results", "impact:1.05", "qoq_revenue_up"],
      oneLiner: "Q2 FY27 revenue ₹73,188 Cr, up 1.3% QoQ and 11.2% YoY (demo).",
      card: tcsResultsCard(),
      clusterKey: "TCS:results:2026-09-30",
    },
    {
      seqId: "DEMO-TCS-RESULTS-AD",
      symbol: "TCS",
      headline: "[Demo] Newspaper publication of financial results",
      hoursAgo: 2,
      category: "results",
      score: 20,
      tier: "noise",
      reasonCodes: ["cluster:child"],
      oneLiner: "Newspaper advertisement of the Q2 results.",
      card: null,
      parent: "DEMO-TCS-RESULTS",
      clusterKey: "TCS:results:2026-09-30",
    },
    {
      seqId: "DEMO-TCS-RESULTS-XBRL",
      symbol: "TCS",
      headline: "[Demo] Integrated Filing (Financial) - XBRL",
      hoursAgo: 3,
      category: "results",
      score: 20,
      tier: "noise",
      reasonCodes: ["cluster:child"],
      oneLiner: "Machine-readable results filing.",
      card: null,
      parent: "DEMO-TCS-RESULTS",
      clusterKey: "TCS:results:2026-09-30",
    },
    {
      seqId: "DEMO-BAJFINANCE-MGMT",
      symbol: "BAJFINANCE",
      headline: "[Demo] Resignation of Chief Risk Officer",
      hoursAgo: 6,
      category: "management_change",
      score: 76,
      tier: "act",
      reasonCodes: ["category:management_change", "seniority:kmp"],
      oneLiner: "Chief Risk Officer resigns; successor to be named (demo).",
      card: CardSchema.parse({
        kind: "management_change",
        people: [
          {
            name: "Arvind Demo Rao",
            role: "Chief Risk Officer",
            direction: "outgoing",
            effectiveDate: "2026-12-31",
            reason: "To pursue opportunities outside the company",
            filingProfile: null,
            profilePage: null,
            link: null,
          },
        ],
        seniority: "kmp",
        summary: "Fictional demo person. The company says a successor will be appointed before the effective date.",
      }),
    },
    {
      seqId: "DEMO-RELIANCE-MA",
      symbol: "RELIANCE",
      headline: "[Demo] Acquisition of majority stake in a consumer brands company",
      hoursAgo: 9,
      category: "m_and_a",
      score: 78,
      tier: "act",
      reasonCodes: ["category:m_and_a", "size:small_vs_mcap"],
      oneLiner: "Buys 62% of a fictional consumer brands company for ₹2,450 Cr (demo).",
      card: CardSchema.parse({
        kind: "deal",
        dealType: "acquisition",
        counterparty: "Demo Consumer Brands Pvt Ltd",
        amountInr: { value: 2450 * CRORE, unit: "inr", derived: false, source: { kind: "filing_pdf", ref: "DEMO-RELIANCE-MA", page: 2 } },
        pctOfMarketCap: 0.13,
        rationale: "Adds packaged-food brands to the retail portfolio (demo).",
      }),
    },
    {
      seqId: "DEMO-ICICIBANK-RATING",
      symbol: "ICICIBANK",
      headline: "[Demo] Credit rating reaffirmed on Tier II bonds",
      hoursAgo: 12,
      category: "credit_rating",
      score: 58,
      tier: "know",
      reasonCodes: ["category:credit_rating", "action:reaffirm"],
      oneLiner: "AAA/Stable reaffirmed on Tier II bonds (demo).",
      card: CardSchema.parse({
        kind: "credit_rating",
        agency: "Demo Ratings",
        instrument: "Tier II bonds",
        previousRating: "AAA/Stable",
        newRating: "AAA/Stable",
        outlook: "Stable",
        action: "reaffirm",
      }),
    },
    {
      seqId: "DEMO-ITC-DIVIDEND",
      symbol: "ITC",
      headline: "[Demo] Interim dividend and record date",
      hoursAgo: 15,
      category: "dividend",
      score: 42,
      tier: "know",
      reasonCodes: ["category:dividend"],
      oneLiner: "Interim dividend of ₹6.50 per share (demo).",
      card: CardSchema.parse({
        kind: "corporate_action",
        action: "dividend",
        amountPerShare: 6.5,
        ratio: null,
        recordDate: "2026-11-28",
        yieldPct: 1.6,
      }),
    },
    {
      seqId: "DEMO-TITAN-PR",
      symbol: "TITAN",
      headline: "[Demo] Press release - festive season business update",
      hoursAgo: 18,
      category: "press_release",
      score: 36,
      tier: "know",
      reasonCodes: ["category:press_release"],
      oneLiner: "Festive-season jewellery sales update (demo).",
      card: generic("Festive-season jewellery sales update (demo)."),
    },
    {
      seqId: "DEMO-INFY-MEET",
      symbol: "INFY",
      headline: "[Demo] Schedule of analyst / institutional investor meetings",
      hoursAgo: 20,
      category: "investor_meetings",
      score: 20,
      tier: "noise",
      reasonCodes: ["category:investor_meetings"],
      oneLiner: "Routine investor meeting schedule (demo).",
      card: generic("Routine investor meeting schedule (demo)."),
    },
    {
      seqId: "DEMO-DIXON-EGM",
      symbol: "DIXON",
      headline: "[Demo] Notice of postal ballot",
      hoursAgo: 22,
      category: "postal_ballot",
      score: 25,
      tier: "noise",
      reasonCodes: ["category:postal_ballot"],
      oneLiner: "Postal ballot notice for routine resolutions (demo).",
      card: generic("Postal ballot notice for routine resolutions (demo)."),
    },
    {
      seqId: "DEMO-POLYCAB-CAPEX",
      symbol: "POLYCAB",
      headline: "[Demo] Board approves capacity expansion",
      hoursAgo: 50,
      category: "capex",
      score: 52,
      tier: "know",
      reasonCodes: ["category:capex"],
      oneLiner: "₹1,200 Cr capex for a new cables plant over two years (demo).",
      card: CardSchema.parse({
        kind: "deal",
        dealType: "capex",
        counterparty: null,
        amountInr: { value: 1200 * CRORE, unit: "inr", derived: false, source: { kind: "filing_pdf", ref: "DEMO-POLYCAB-CAPEX", page: 1 } },
        pctOfMarketCap: 1.1,
        rationale: "New cables plant to be commissioned over two years (demo).",
      }),
    },
  ];
}

// ---------- research (CDSL) ----------

const CDSL_CHUNKS = [
  {
    page: 4,
    section: "Opening remarks",
    text:
      "This is a demo transcript excerpt. Revenue from operations for the quarter was Rs 312 crore, up 14% year on year, " +
      "driven by annual issuer charges and transaction income. We added 1.1 crore new demat accounts in the half year.",
  },
  {
    page: 9,
    section: "Guidance",
    text:
      "Demo excerpt: for FY27 we expect revenue growth in the range of 15 to 18 percent, and we intend to keep EBITDA margin " +
      "above 55 percent while we invest in technology. Capex for the year should be around Rs 120 crore.",
  },
  {
    page: 14,
    section: "Q&A",
    text:
      "Demo excerpt: transaction revenue is cyclical and depends on market volumes; a sustained fall in retail activity " +
      "would hurt this line. Regulatory changes to depository fees remain a risk we monitor.",
  },
];

export async function seedDemoData(sql: Sql, now = new Date()): Promise<{ announcements: number; prices: number; runId: string }> {
  await wipeDemoData(sql);
  const holdings = (await sql<{ symbol: string }[]>`SELECT symbol FROM holdings ORDER BY symbol`).map((r) => r.symbol);
  const companies = new Set((await sql<{ symbol: string }[]>`SELECT symbol FROM companies`).map((r) => r.symbol));
  if (!companies.has("CDSL") || !companies.has("TCS")) throw new Error("Run `npm run seed -w @finn/db` first (companies missing)");

  // Never mix synthetic and real prices in one series: symbols with real rows get no demo prices.
  const withRealPrices = new Set(
    (await sql<{ symbol: string }[]>`SELECT DISTINCT symbol FROM prices_eod WHERE source <> ${DEMO.priceSource}`).map((r) => r.symbol),
  );
  const sessions = recentSessions(now, PRICE_SESSIONS);
  const prices = holdings.filter((s) => !withRealPrices.has(s)).flatMap((s) => buildPrices(s, sessions));
  const announcements = demoAnnouncements().filter((a) => companies.has(a.symbol));

  let runId = "";
  await sql.begin(async (tx) => {
    for (const p of prices) {
      await tx`
        INSERT INTO prices_eod (symbol, session_date, open, high, low, close, prev_close, volume, avg20_volume, source)
        VALUES (${p.symbol}, ${p.session_date}, ${p.open}, ${p.high}, ${p.low}, ${p.close}, ${p.prev_close}, ${p.volume},
                ${p.avg20_volume}, ${p.source})
        ON CONFLICT (symbol, session_date) DO NOTHING`;
    }

    // Parents first so children can reference them.
    for (const a of [...announcements].sort((x, y) => Number(Boolean(x.parent)) - Number(Boolean(y.parent)))) {
      const publishedAt = new Date(now.getTime() - a.hoursAgo * HOUR);
      await tx`
        INSERT INTO announcements (seq_id, symbol, headline, body_text, pdf_url, published_at, raw, category, category_confidence,
                                   category_source, score, reason_codes, tier, cluster_key, parent_seq_id, one_liner, card, status)
        VALUES (${a.seqId}, ${a.symbol}, ${a.headline}, ${`${a.oneLiner} This is demo data inserted by apps/api/scripts/demo-data.ts.`},
                ${`${DEMO.docUrlPrefix}nse/${a.seqId}.pdf`}, ${publishedAt}, ${tx.json({ demo: true })}, ${a.category}, 0.99, 'rule',
                ${a.score}, ${a.reasonCodes}::text[], ${a.tier}, ${a.clusterKey ?? null}, ${a.parent ?? null}, ${a.oneLiner},
                ${a.card ? tx.json(asJson(a.card)) : null}, 'ready')`;
    }

    const filings = [
      { seqId: "DEMO-QF-TCS-Q2FY27", start: "2026-07-01", end: "2026-09-30", q: TCS_Q.q2fy27, ytdRevenue: 145463 },
      { seqId: "DEMO-QF-TCS-Q1FY27", start: "2026-04-01", end: "2026-06-30", q: TCS_Q.q1fy27, ytdRevenue: 72275 },
      { seqId: "DEMO-QF-TCS-Q2FY26", start: "2025-07-01", end: "2025-09-30", q: TCS_Q.q2fy26, ytdRevenue: 129798 },
    ];
    for (const f of filings) {
      await tx`
        INSERT INTO quarterly_filings (seq_id, symbol, period_start, period_end, basis, statement_family, taxonomy, audited, xbrl_url, status)
        VALUES (${f.seqId}, 'TCS', ${f.start}, ${f.end}, 'consolidated', 'industrial', 'INTEGRATED_FILING_INDAS', false,
                ${`${DEMO.docUrlPrefix}xbrl/${f.seqId}.xml`}, 'parsed')`;
      const facts: [string, string, number, boolean][] = [
        ["RevenueFromOperations", "OneD", f.q.revenue, false],
        ["ProfitLossForPeriod", "OneD", f.q.pat, false],
        ["FinnEbitda", "OneD", f.q.ebitda, true],
        ["RevenueFromOperations", "FourD", f.ytdRevenue, false],
      ];
      for (const [concept, context, crore, derived] of facts) {
        await tx`
          INSERT INTO financial_facts (filing_seq_id, concept, context, period_start, period_end, value, derived)
          VALUES (${f.seqId}, ${concept}, ${context}, ${context === "FourD" ? `${f.end.slice(0, 4)}-04-01` : f.start}, ${f.end},
                  ${crore * CRORE}, ${derived})`;
      }
    }

    // The alert describes whatever prices are actually stored (real or demo), so it never contradicts the chart.
    const [rule] = await tx<{ id: string }[]>`
      SELECT id FROM alert_rules WHERE definition->>'type' = 'price_move' ORDER BY created_at LIMIT 1`;
    const [mover] = await tx<{ symbol: string; session_date: string; close: number; prev_close: number }[]>`
      SELECT DISTINCT ON (p.symbol) p.symbol, p.session_date::text AS session_date, p.close::float8 AS close,
             COALESCE(p.prev_close, lag(p.close) OVER (PARTITION BY p.symbol ORDER BY p.session_date))::float8 AS prev_close
      FROM prices_eod p JOIN holdings h ON h.symbol = p.symbol
      ORDER BY p.symbol, p.session_date DESC`.then((rows) =>
      rows
        .filter((r) => r.prev_close > 0)
        .sort((a, b) => Math.abs(b.close / b.prev_close - 1) - Math.abs(a.close / a.prev_close - 1)),
    );
    if (rule && mover) {
      const movePct = Math.round((mover.close / mover.prev_close - 1) * 1000) / 10;
      await tx`
        INSERT INTO alerts (rule_id, symbol, kind, event_key, title, body, session_date)
        VALUES (${rule.id}, ${mover.symbol}, 'price_move', ${`${DEMO.alertKeyPrefix}price_move:${mover.symbol}:${mover.session_date}`},
                ${`${mover.symbol} ${movePct < 0 ? "fell" : "rose"} ${Math.abs(movePct)}%`},
                ${`Closed at ₹${mover.close.toLocaleString("en-IN")} vs ₹${mover.prev_close.toLocaleString("en-IN")}. Demo alert: inserted by the demo-data script, not the alert engine.`},
                ${mover.session_date})`;
    }

    // CDSL research run with a demo transcript, chunks, guidance and four finished modules.
    const created = new Date(now.getTime() - HOUR);
    const [doc] = await tx<{ id: string }[]>`
      INSERT INTO documents (symbol, doc_type, period_label, period_end, url, pages, text_quality, status)
      VALUES ('CDSL', 'transcript', 'Q2 FY27 (demo)', '2026-09-30', ${`${DEMO.docUrlPrefix}cdsl/q2fy27-earnings-call`}, 18, 0.97, 'ready')
      RETURNING id`;
    if (!doc) throw new Error("demo document insert failed");
    const chunkIds: string[] = [];
    for (const [i, c] of CDSL_CHUNKS.entries()) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO doc_chunks (document_id, chunk_index, symbol, page_start, page_end, section, text, token_estimate)
        VALUES (${doc.id}, ${i}, 'CDSL', ${c.page}, ${c.page}, ${c.section}, ${c.text}, ${Math.ceil(c.text.length / 4)})
        RETURNING id`;
      chunkIds.push(row!.id);
    }
    const cite = (i: number, quote: string) => ({
      chunkId: chunkIds[i]!,
      documentId: doc.id,
      documentLabel: "Earnings call Q2 FY27 (demo)",
      page: CDSL_CHUNKS[i]!.page,
      quote,
      url: null,
    });
    const claim = (text: string, i: number, quote: string) => ({ text, citations: [cite(i, quote)], grounded: true });

    const guidance = [
      { metric: "revenue_growth", low: 15, high: 18, unit: "pct", quote: "for FY27 we expect revenue growth in the range of 15 to 18 percent", verdict: "pending", chunk: 1 },
      { metric: "ebitda_margin", low: 55, high: null, unit: "pct", quote: "keep EBITDA margin above 55 percent", verdict: "pending", chunk: 1 },
      { metric: "capex", low: 120, high: 120, unit: "inr_crore", quote: "Capex for the year should be around Rs 120 crore", verdict: "pending", chunk: 1 },
    ] as const;
    const promises = [];
    for (const g of guidance) {
      const [item] = await tx<{ id: string }[]>`
        INSERT INTO guidance_items (symbol, document_id, chunk_id, page, metric, statement_type, low, high, unit, horizon_label,
                                    horizon_start, horizon_end, speaker, quote, said_in, said_on)
        VALUES ('CDSL', ${doc.id}, ${chunkIds[g.chunk]!}, ${CDSL_CHUNKS[g.chunk]!.page}, ${g.metric}, 'explicit_guidance', ${g.low}, ${g.high},
                ${g.unit}, 'FY27', '2026-04-01', '2027-03-31', 'MD & CEO (demo)', ${g.quote}, 'Q2 FY27 call (demo)', '2026-10-30')
        RETURNING id`;
      await tx`
        INSERT INTO guidance_checks (guidance_id, verdict, explanation)
        VALUES (${item!.id}, ${g.verdict}, 'FY27 has not ended yet, so this is still open (demo).')`;
      promises.push({
        id: item!.id,
        metric: g.metric,
        statementType: "explicit_guidance",
        low: g.low,
        high: g.high,
        unit: g.unit,
        horizonLabel: "FY27",
        horizonEnd: "2027-03-31",
        saidIn: "Q2 FY27 call (demo)",
        speaker: "MD & CEO (demo)",
        quote: g.quote,
        citation: cite(g.chunk, g.quote),
        actual: null,
        actualPeriod: null,
        actualSource: null,
        verdict: g.verdict,
        explanation: "FY27 has not ended yet, so this is still open (demo).",
      });
    }

    const modules = {
      promise_ledger: PromiseLedgerPayloadSchema.parse({
        summary: { elapsed: 0, delivered: 0, missed: 0, pending: promises.length, quietlyDropped: 0 },
        promises,
        transcriptsUsed: ["Q2 FY27 (demo)"],
      }),
      financial_snapshot: FinancialSnapshotPayloadSchema.parse({
        headline: [
          { label: "Revenue", value: 312 * CRORE, unit: "inr", period: "Q2 FY27", source: "Earnings call (demo)" },
          { label: "Revenue growth YoY", value: 14, unit: "pct", period: "Q2 FY27", source: "Earnings call (demo)" },
        ],
        series: [
          {
            key: "revenue",
            label: "Revenue",
            unit: "inr_crore",
            source: "screener.in (demo)",
            points: [
              { period: "FY23", value: 555 },
              { period: "FY24", value: 812 },
              { period: "FY25", value: 1082 },
              { period: "FY26", value: 1135 },
            ],
          },
        ],
        takeaways: [claim("Quarterly revenue grew 14% YoY to ₹312 Cr.", 0, "Revenue from operations for the quarter was Rs 312 crore, up 14% year on year")],
      }),
      cash_quality: CashQualityPayloadSchema.parse({
        periods: [
          { period: "H1 FY27", cfo: 290 * CRORE, pat: 255 * CRORE, cashConversion: 1.14, capex: 48 * CRORE, fcf: 242 * CRORE, debtToEquity: 0, note: "Demo figures" },
          { period: "FY26", cfo: 540 * CRORE, pat: 470 * CRORE, cashConversion: 1.15, capex: 95 * CRORE, fcf: 445 * CRORE, debtToEquity: 0, note: null },
        ],
        takeaways: [claim("Capex guidance is modest relative to cash generation.", 1, "Capex for the year should be around Rs 120 crore")],
      }),
      bull_bear: BullBearPayloadSchema.parse({
        bull: [claim("Account additions keep the issuer and transaction base growing.", 0, "We added 1.1 crore new demat accounts in the half year")],
        bear: [
          claim("Transaction revenue falls if retail market activity slows.", 2, "a sustained fall in retail activity would hurt this line"),
          claim("Depository fee regulation is an open risk.", 2, "Regulatory changes to depository fees remain a risk we monitor"),
        ],
      }),
    };

    const [run] = await tx<{ id: string }[]>`
      INSERT INTO research_runs (symbol, status, modules, requested_by, claimed_at, created_at, updated_at)
      VALUES ('CDSL', 'completed', ${Object.keys(modules)}::text[], ${DEMO.requestedBy}, ${created}, ${created}, ${new Date(created.getTime() + 150_000)})
      RETURNING id`;
    runId = run!.id;
    for (const [key, payload] of Object.entries(modules)) {
      await tx`
        INSERT INTO research_modules (run_id, module, status, payload, updated_at)
        VALUES (${runId}, ${key}, 'done', ${tx.json(asJson(payload))}, ${new Date(created.getTime() + 140_000)})`;
    }
    const events: [string, string, Record<string, unknown> | null][] = [
      ["run.queued", "Queued research for Central Depository Services (India) Ltd", { symbol: "CDSL" }],
      ["run.started", "Worker started", null],
      ["document.discovered", "Found Q2 FY27 earnings call transcript (demo)", { documentId: doc.id }],
      ["document.extracted", "Read 18 pages", { documentId: doc.id, pages: 18 }],
      ["document.embedded", `Indexed ${CDSL_CHUNKS.length} passages`, { documentId: doc.id, chunks: CDSL_CHUNKS.length }],
      ...Object.keys(modules).map((m): [string, string, Record<string, unknown>] => ["module.completed", `Finished ${m.replace(/_/g, " ")}`, { module: m }]),
      ["run.completed", "Research ready", null],
    ];
    for (const [i, [type, message, data]] of events.entries()) {
      await tx`
        INSERT INTO research_events (run_id, type, message, data, created_at)
        VALUES (${runId}, ${type}, ${message}, ${data ? tx.json(asJson(data)) : null}, ${new Date(created.getTime() + i * 15_000)})`;
    }
  });

  return { announcements: announcements.length, prices: prices.length, runId };
}

function assertSafeTarget(url: string, allowRemote: boolean): void {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to write demo data with NODE_ENV=production");
  const host = new URL(url).hostname;
  if (!allowRemote && !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Refusing to write demo data to ${host}; pass --allow-remote if you really mean it`);
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  assertSafeTarget(url, args.has("--allow-remote"));
  const sql = getDb({ url, max: 1 });
  if (args.has("--wipe")) {
    await wipeDemoData(sql);
    console.log("Removed all demo rows");
    return;
  }
  const result = await seedDemoData(sql);
  console.log(
    `Demo data ready (${istDateString(new Date())}): ${result.announcements} announcements, ${result.prices} price rows, CDSL research run ${result.runId}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
