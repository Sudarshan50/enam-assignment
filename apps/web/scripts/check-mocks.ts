/**
 * Validates every mock fixture against the shared zod contracts the live API must satisfy.
 * Run: npx tsx scripts/check-mocks.ts   (from apps/web)
 */
import {
  AlertSchema,
  AlertRuleSchema,
  AskResponseSchema,
  BullBearPayloadSchema,
  BusinessSnapshotPayloadSchema,
  CashQualityPayloadSchema,
  DigestItemSchema,
  DigestResponseSchema,
  FinancialSnapshotPayloadSchema,
  HoldingSchema,
  PromiseLedgerPayloadSchema,
  ResearchEventSchema,
  ResearchRunSchema,
} from "@finn/shared";
import type { z } from "zod";
import { buildAlerts, buildRules, previewRule } from "../src/mocks/alerts";
import { allMockItems, buildDigest } from "../src/mocks/digest";
import { buildEngine } from "../src/mocks/engine";
import { buildHoldings, PORTFOLIO } from "../src/mocks/portfolio";
import { CDSL_ASK_ANSWERS, CDSL_BULL_BEAR, CDSL_BUSINESS, CDSL_CASH, CDSL_DEFAULT_ANSWER, CDSL_FINANCIALS, CDSL_LEDGER } from "../src/mocks/research-cdsl";
import { getMockRun, mockRunEventsSince, startMockRun } from "../src/mocks/runs";
import { EngineResponseSchema, RulePreviewSchema, StartRunResponseSchema } from "../src/lib/api/schemas";

const now = new Date();
let failures = 0;
let checks = 0;

function check<S extends z.ZodType>(label: string, schema: S, value: unknown) {
  checks += 1;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  failures += 1;
  console.error(`✗ ${label}`);
  for (const issue of result.error.issues.slice(0, 5)) console.error(`   ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return null;
}

function expect(label: string, condition: boolean) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`✗ ${label}`);
  }
}

for (const window of ["24h", "3d", "7d"] as const) {
  for (const scenario of ["default", "stale", "caughtup"] as const) {
    const digest = check(`digest ${window}/${scenario}`, DigestResponseSchema, buildDigest(now, window, scenario));
    if (digest) {
      expect(`digest ${window}/${scenario} counts match`, digest.counts.act === digest.act.length && digest.counts.know === digest.know.length);
      expect(`digest ${window}/${scenario} stale flag`, scenario !== "stale" || digest.sourceHealth.some((s) => s.stale));
    }
  }
}
const items = allMockItems(now);
items.forEach((item) => check(`digest item ${item.symbol} ${item.id}`, DigestItemSchema, item));
const kinds = new Set(items.map((i) => i.card?.kind).filter(Boolean));
for (const kind of ["results", "management_change", "deal", "credit_rating", "corporate_action", "ownership", "litigation", "generic"]) {
  expect(`a ${kind} card exists`, kinds.has(kind as never));
}
expect("a 'numbers not filed yet' results card exists", items.some((i) => i.card?.kind === "results" && i.card.status === "not_filed_yet"));
expect("a banking results card with NII and PPOP exists", items.some((i) => i.card?.kind === "results" && i.card.statementFamily === "banking" && i.card.metrics.some((m) => m.key === "ppop")));

const holdings = buildHoldings(now);
holdings.forEach((h) => check(`holding ${h.symbol}`, HoldingSchema, h));
expect("18 holdings", holdings.length === 18 && PORTFOLIO.length === 18);
expect("sparklines have 30 points", holdings.every((h) => h.sparkline.length === 30));

buildAlerts(now).forEach((a) => check(`alert ${a.id}`, AlertSchema, a));
buildRules(now).forEach((r) => check(`rule ${r.id}`, AlertRuleSchema, r));
for (const text of ["Tell me if any bank falls more than 3%", "Volume above 2.5× on DIXON or POLYCAB", "Any management change or M&A", "gibberish"]) {
  check(`rule preview "${text}"`, RulePreviewSchema, previewRule(text, now));
}
check("engine", EngineResponseSchema, buildEngine(now, "default"));

const ledger = check("CDSL promise ledger", PromiseLedgerPayloadSchema, CDSL_LEDGER);
if (ledger) {
  const count = (v: string) => ledger.promises.filter((p) => p.verdict === v).length;
  expect("ledger summary matches promises", ledger.summary.delivered === count("delivered") && ledger.summary.missed === count("missed") && ledger.summary.pending === count("pending") && ledger.summary.quietlyDropped === count("quietly_dropped"));
  expect("ledger elapsed = delivered + missed", ledger.summary.elapsed === ledger.summary.delivered + ledger.summary.missed);
  expect("every promise quote matches its citation", ledger.promises.every((p) => p.quote === p.citation.quote));
}
check("CDSL financial snapshot", FinancialSnapshotPayloadSchema, CDSL_FINANCIALS);
check("CDSL cash quality", CashQualityPayloadSchema, CDSL_CASH);
check("CDSL business snapshot", BusinessSnapshotPayloadSchema, CDSL_BUSINESS);
const bb = check("CDSL bull/bear", BullBearPayloadSchema, CDSL_BULL_BEAR);
expect("one claim could not be grounded", Boolean(bb && [...bb.bull, ...bb.bear].some((c) => !c.grounded && c.citations.length === 0)));
CDSL_ASK_ANSWERS.forEach((a, i) => check(`ask answer ${i}`, AskResponseSchema, { answer: a.answer, insufficientSources: false }));
check("ask default answer", AskResponseSchema, { answer: CDSL_DEFAULT_ANSWER, insufficientSources: false });

const started = check("start run", StartRunResponseSchema, startMockRun("CDSL"));
if (started) {
  check("CDSL run", ResearchRunSchema, getMockRun(started.runId));
  mockRunEventsSince(started.runId, 0).forEach((e) => check(`event ${e.id} ${e.type}`, ResearchEventSchema, e));
  expect("pre-warmed CDSL run is complete", getMockRun(started.runId)?.status === "completed");
}
const cold = startMockRun("ASTRAL");
check("cold run", ResearchRunSchema, getMockRun(cold.runId));

if (failures) {
  console.error(`\n${failures} of ${checks} mock checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} mock checks passed against @finn/shared contracts.`);
