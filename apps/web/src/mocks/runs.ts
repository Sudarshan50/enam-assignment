import { MODULE_KEYS, type ModuleKey, type ResearchEvent, type ResearchModule, type ResearchRun, type RunStatus } from "@finn/shared";
import { companyName } from "./portfolio";
import { CDSL_DOCS, CDSL_PAYLOADS } from "./research-cdsl";

type EventType = ResearchEvent["type"];

interface Step {
  at: number;
  type: EventType;
  message: string;
  data?: Record<string, unknown>;
  module?: ModuleKey;
  docsReady?: number;
}

interface MockRun {
  id: string;
  symbol: string;
  startedAt: number;
  steps: Step[];
  hasFixtures: boolean;
}

const MODULE_LABEL: Record<ModuleKey, string> = {
  promise_ledger: "Promise Ledger",
  financial_snapshot: "Financial snapshot",
  cash_quality: "Cash quality",
  business_snapshot: "Business snapshot",
  bull_bear: "Bull vs bear",
};

const MODULE_ORDER: ModuleKey[] = ["promise_ledger", "financial_snapshot", "cash_quality", "business_snapshot", "bull_bear"];

function buildSteps(symbol: string, hasFixtures: boolean): Step[] {
  const steps: Step[] = [
    { at: 0, type: "run.queued", message: `Queued research for ${symbol}` },
    { at: 600, type: "run.started", message: `Resolved ${symbol} on the NSE equity master list` },
    {
      at: 1500,
      type: "document.discovered",
      message: hasFixtures ? "Found 2 annual reports, 8 concall transcripts" : "Found 2 annual reports, 6 concall transcripts",
      data: { annualReports: 2, transcripts: hasFixtures ? 8 : 6 },
    },
    {
      at: 2600,
      type: "document.downloaded",
      message: `Downloaded ${hasFixtures ? 10 : 8} documents · ${hasFixtures ? 41 : 33} MB, checksums recorded`,
      docsReady: 0,
    },
    { at: 3600, type: "document.extracted", message: "Reading Q2 FY27 call (34 pages)", docsReady: 4 },
    { at: 4700, type: "document.extracted", message: "Reading Annual Report FY26 (298 pages)", docsReady: 8 },
    { at: 5800, type: "document.embedded", message: "Indexed 1,284 passages across 10 documents", data: { chunks: 1284 }, docsReady: 10 },
  ];
  let t = 6400;
  for (const key of MODULE_ORDER) {
    steps.push({ at: t, type: "module.started", message: `Building ${MODULE_LABEL[key]}`, module: key });
    t += key === "promise_ledger" ? 2200 : 1300;
    steps.push({
      at: t,
      type: "module.completed",
      module: key,
      message: hasFixtures
        ? key === "promise_ledger"
          ? "Promise Ledger ready — delivered 4 of 5 elapsed promises"
          : `${MODULE_LABEL[key]} ready`
        : `${MODULE_LABEL[key]}: not enough source material in mock data`,
    });
    t += 250;
  }
  steps.push({ at: t + 200, type: "run.completed", message: hasFixtures ? "Research complete · 5 modules, 34 citations" : "Run finished with gaps" });
  return steps;
}

const runs = new Map<string, MockRun>();
const latestBySymbol = new Map<string, string>();

function ensureSeeded() {
  if (latestBySymbol.has("CDSL")) return;
  const id = "run-cdsl-prewarmed";
  runs.set(id, { id, symbol: "CDSL", startedAt: Date.now() - 26 * 3_600_000, steps: buildSteps("CDSL", true), hasFixtures: true });
  latestBySymbol.set("CDSL", id);
}

export function startMockRun(symbol: string): { runId: string; status: RunStatus; cached?: boolean } {
  ensureSeeded();
  const existing = latestBySymbol.get(symbol);
  if (existing) {
    const run = runs.get(existing)!;
    const status = computeStatus(run);
    if (status === "completed" || !isTerminal(status)) return { runId: existing, status, cached: status === "completed" };
  }
  const id = `run-${symbol.toLowerCase()}-${Date.now().toString(36)}`;
  const hasFixtures = symbol === "CDSL";
  runs.set(id, { id, symbol, startedAt: Date.now(), steps: buildSteps(symbol, hasFixtures), hasFixtures });
  latestBySymbol.set(symbol, id);
  return { runId: id, status: "queued" };
}

function isTerminal(status: RunStatus) {
  return status === "completed" || status === "partial" || status === "failed" || status === "cancelled";
}

function elapsed(run: MockRun) {
  return Date.now() - run.startedAt;
}

function computeStatus(run: MockRun): RunStatus {
  const t = elapsed(run);
  const done = run.steps.filter((s) => s.at <= t);
  const last = done.at(-1);
  if (!last || last.type === "run.queued") return "queued";
  if (last.type === "run.completed") return run.hasFixtures ? "completed" : "partial";
  if (done.some((s) => s.type === "module.started")) return "synthesizing";
  return "processing_docs";
}

export function getMockRun(runId: string): ResearchRun | null {
  ensureSeeded();
  const run = runs.get(runId);
  if (!run) return null;
  const t = elapsed(run);
  const done = run.steps.filter((s) => s.at <= t);
  const docsReady = Math.max(0, ...done.map((s) => s.docsReady ?? -1));
  const discovered = done.some((s) => s.type === "document.discovered");
  const docs = run.hasFixtures ? CDSL_DOCS : CDSL_DOCS.slice(0, 8).map((d) => ({ ...d, label: d.label, url: "#" }));

  const modules: ResearchModule[] = MODULE_KEYS.map((key) => {
    const started = done.find((s) => s.module === key && s.type === "module.started");
    const completed = done.find((s) => s.module === key && s.type === "module.completed");
    const at = new Date(run.startedAt + (completed?.at ?? started?.at ?? 0)).toISOString();
    if (completed) {
      return run.hasFixtures
        ? { key, status: "done", payload: CDSL_PAYLOADS[key], error: null, updatedAt: at }
        : {
            key,
            status: "insufficient_sources",
            payload: null,
            error: "Mock mode only ships research fixtures for CDSL. Point the app at the live API to research this company.",
            updatedAt: at,
          };
    }
    return { key, status: started ? "running" : "pending", payload: null, error: null, updatedAt: at };
  });

  return {
    id: run.id,
    symbol: run.symbol,
    companyName: companyName(run.symbol),
    status: computeStatus(run),
    createdAt: new Date(run.startedAt).toISOString(),
    updatedAt: new Date(run.startedAt + (done.at(-1)?.at ?? 0)).toISOString(),
    modules,
    documents: discovered
      ? docs.map((d, i) => ({ id: d.id, label: d.label, status: i < docsReady ? "ready" : "downloading", pages: d.pages, url: d.url }))
      : [],
  };
}

export function getMockRunForSymbol(symbol: string): ResearchRun | null {
  ensureSeeded();
  const id = latestBySymbol.get(symbol);
  return id ? getMockRun(id) : null;
}

export function mockRunEventsSince(runId: string, lastId: number): ResearchEvent[] {
  const run = runs.get(runId);
  if (!run) return [];
  const t = elapsed(run);
  return run.steps
    .map((s, i) => ({ step: s, id: i + 1 }))
    .filter(({ step, id }) => step.at <= t && id > lastId)
    .map(({ step, id }) => ({
      id,
      runId,
      type: step.type,
      message: step.message,
      data: step.module ? { module: step.module, ...(step.data ?? {}) } : (step.data ?? null),
      createdAt: new Date(run.startedAt + step.at).toISOString(),
    }));
}
