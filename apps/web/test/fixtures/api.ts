/**
 * Response bodies in the exact shapes the live API returned (apps/api/src/contracts.ts + @finn/shared),
 * trimmed to one or two items. Keep these in sync with what `e2e/run.mjs` observes.
 */

const xbrl = (ref: string) => ({ kind: "xbrl" as const, ref });
const inr = (value: number, derived = false) => ({ value, unit: "inr" as const, derived, source: xbrl("DEMO-TCS-RESULTS-XBRL") });

export const resultsItem = {
  id: "DEMO-TCS-RESULTS",
  symbol: "TCS",
  companyName: "Tata Consultancy Services Ltd",
  category: "results",
  tier: "act",
  score: 84,
  reasonCodes: ["category:results", "pat_yoy_+11.1%", "revenue_yoy_+11.2%"],
  headline: "[Demo] Financial Results for the quarter ended September 30, 2026",
  oneLiner: "Q2 FY27 revenue ₹73,188 Cr, up 11.2% YoY",
  publishedAt: "2026-11-15T05:38:15.619Z",
  pdfUrl: "demo://nse/DEMO-TCS-RESULTS.pdf",
  card: {
    kind: "results",
    periodEnd: "2026-09-30",
    periodLabel: "Q2 FY27",
    basis: "consolidated",
    statementFamily: "industrial",
    audited: false,
    status: "ready",
    metrics: [
      { key: "revenue", label: "Revenue", current: inr(731_880_000_000), previousQuarter: inr(722_500_000_000), yearAgoQuarter: inr(658_200_000_000), qoqPct: 1.3, yoyPct: 11.2 },
      { key: "ebitda", label: "EBITDA", current: inr(199_500_000_000, true), previousQuarter: inr(194_200_000_000, true), yearAgoQuarter: inr(179_700_000_000, true), qoqPct: 2.7, yoyPct: 11 },
      { key: "pat", label: "PAT", current: inr(132_400_000_000), previousQuarter: inr(129_300_000_000), yearAgoQuarter: inr(119_200_000_000), qoqPct: 2.4, yoyPct: 11.1 },
    ],
    marginBps: { label: "EBITDA margin", current: 27.26, qoqBps: 39, yoyBps: -7 },
    read: "Demo data: revenue up 1.3% QoQ",
    ebitdaDefinition: "Profit before exceptional items, tax, finance costs and depreciation.",
  },
  linked: [
    { seqId: "DEMO-TCS-RESULTS-XBRL", headline: "[Demo] Integrated Filing (Financial)", pdfUrl: "demo://nse/DEMO-TCS-RESULTS-XBRL.xml", publishedAt: "2026-11-15T05:38:15.619Z" },
  ],
};

export const genericItem = {
  id: "106857341",
  symbol: "TITAN",
  companyName: "Titan Company Ltd",
  category: "fund_raise",
  tier: "know",
  score: 68,
  reasonCodes: ["subject:generic", "holding"],
  headline: "Titan Company Limited has informed the Exchange about fund raising",
  oneLiner: "Titan Company Limited has fully redeemed commercial paper.",
  publishedAt: "2026-11-12T13:15:52.000Z",
  pdfUrl: "https://nsearchives.nseindia.com/corporate/TITAN_12112026.pdf",
  card: { kind: "generic", oneLiner: "Titan Company Limited has fully redeemed commercial paper." },
  linked: [],
};

export const sourceHealth = {
  source: "nse_announcements",
  lastSuccessAt: "2026-11-15T08:17:32.720Z",
  lastAttemptAt: "2026-11-15T08:17:32.720Z",
  consecutiveFailures: 0,
  lastError: null,
  stale: false,
};

export const digest = {
  window: { from: "2026-11-08T08:38:52.430Z", to: "2026-11-15T08:38:52.430Z" },
  asOf: "2026-11-15T08:17:32.720Z",
  caughtUp: false,
  counts: { act: 1, know: 1, noise: 0 },
  act: [resultsItem],
  know: [genericItem],
  noise: [],
  sourceHealth: [sourceHealth],
};

/** GET /announcements/:seqId returns a DigestItem plus detail fields. */
export const announcementDetail = { ...resultsItem, bodyText: "Q2 FY27 revenue ₹73,188 Cr", parentId: null, status: "ready", dismissed: false };

export const holding = {
  symbol: "ADANIPORTS",
  name: "Adani Ports and Special Economic Zone Ltd",
  statementFamily: "industrial",
  close: 1903.3,
  changePct: -1.38,
  volume: 1_937_817,
  volumeVsAvg: 0.68,
  sessionDate: "2026-11-13",
  sparkline: Array.from({ length: 30 }, (_, i) => 1798.3 + i * 3.5),
  unreadCount: 0,
  researchReady: false,
};

export const alert = {
  id: "90b9a95a-0596-47ab-804d-f7163f2b7d11",
  ruleId: "eb90d11e-7635-4bff-9787-47937559e3a0",
  ruleName: "Big daily move",
  symbol: "POLYCAB",
  kind: "price_move",
  title: "POLYCAB fell 2.2%",
  body: "Closed at ₹7,904 vs ₹8,080.5.",
  sessionDate: "2026-11-13",
  announcementId: null,
  createdAt: "2026-11-15T08:38:15.625Z",
  readAt: null,
};

export const rule = {
  id: "eb90d11e-7635-4bff-9787-47937559e3a0",
  name: "Big daily move",
  enabled: true,
  definition: { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 5 },
  createdAt: "2026-11-15T07:46:29.558Z",
};

/** POST /alert-rules/preview — API backtest is a per-symbol summary, not per-session hits. */
export const previewWithFires = {
  definition: { type: "volume_spike", scope: { kind: "symbols", symbols: ["DIXON", "POLYCAB"] }, multiple: 2.5 },
  resolvedSymbols: ["DIXON", "POLYCAB"],
  explanation: "Alert when DIXON or POLYCAB trades at least 2.5× its average volume. It would have fired 1 time in the last 30 sessions (DIXON).",
  backtest: { sessions: 30, fires: 1, bySymbol: [{ symbol: "DIXON", fires: 1, lastFiredOn: "2026-11-02" }], note: null },
};

export const previewUnparsed = { definition: null, resolvedSymbols: [], explanation: "Try something like …", backtest: null };

export const engine = {
  llm: { callsToday: 59, cacheHitRate: 0.271, promptTokensToday: 591_532, completionTokensToday: 33_009, jsonAdherenceRate: 1, budgetRemaining: 1957 },
  embeddings: { neuronsToday: 215.4, chunksTotal: 1600 },
  documents: { ready: 20, failed: 1, scanned: 0 },
  byPurpose: [{ purpose: "guidance_extract", calls: 45, tokens: 475_837, cacheHits: 14 }],
  llm7d: { calls: 59, promptTokens: 591_532, completionTokens: 33_009, cacheHits: 16 },
  announcements: { processedToday: 38, processed7d: 38, ready: 38, pending: 0, failed: 0 },
  sourceHealth: [sourceHealth],
  lastIngestAt: "2026-11-15T08:17:43.716Z",
  asOf: "2026-11-15T08:38:52.486Z",
};

export const prefs = { categoryWeights: {}, defaultWindow: "24h", quietHours: null, updatedAt: "2026-11-15T08:38:04.207Z" };

export const citation = {
  chunkId: "c-1",
  documentId: "db8cd17e-31df-4131-9600-fbad3f000001",
  documentLabel: "transcript Q2 FY27",
  page: 4,
  quote: "for FY27 we expect revenue growth of 15 to 18%",
  url: "https://nsearchives.nseindia.com/cdsl-q2fy27.pdf",
};

export const run = {
  id: "90ab5ae8-5968-43c8-80d4-6a52c8000001",
  symbol: "CDSL",
  companyName: "Central Depository Services (India) Ltd",
  status: "completed",
  createdAt: "2026-11-15T08:24:06.666Z",
  updatedAt: "2026-11-15T08:24:18.686Z",
  modules: [
    {
      key: "promise_ledger",
      status: "done",
      payload: { summary: { elapsed: 0, delivered: 0, missed: 0, pending: 1, quietlyDropped: 0 }, promises: [], transcriptsUsed: ["Q2 FY27 concall"] },
      error: null,
      updatedAt: "2026-11-15T08:24:14.029Z",
    },
    { key: "bull_bear", status: "done", payload: { bull: [{ text: "Market leader", citations: [citation], grounded: true }], bear: [] }, error: null, updatedAt: "2026-11-15T08:24:18.000Z" },
  ],
  documents: [{ id: citation.documentId, label: "transcript Q2 FY27", status: "ready", pages: 11, url: citation.url }],
};

/** GET /companies/:symbol/research — envelope with the run plus denormalised modules and ledger. */
export const companyResearch = {
  symbol: "CDSL",
  companyName: "Central Depository Services (India) Ltd",
  run,
  modules: run.modules,
  promiseLedger: { summary: { elapsed: 0, delivered: 0, missed: 0, pending: 1, quietlyDropped: 0 }, promises: [] },
};

export const companyResearchEmpty = { symbol: "ZOMATO", companyName: "Zomato Ltd", run: null, modules: [], promiseLedger: null };

export const startRunCached = { runId: run.id, status: "completed", cached: true };

export const askAnswer = { answer: [{ text: "Revenue guidance is 15–18% for FY27.", citations: [citation], grounded: true }], insufficientSources: false };

export const searchResult = { symbol: "CDSL", name: "Central Depository Services (India) Ltd", statementFamily: "industrial", isHolding: false };
