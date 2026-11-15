/**
 * In-browser stand-in for the API, used when NEXT_PUBLIC_USE_MOCKS=1. Every value returned
 * here is parsed by the same zod schema as the live response (see lib/api/*).
 *
 * Append `?scenario=stale` or `?scenario=caughtup` to any URL to preview those digest states.
 */
import type { AlertRule, AlertRuleDefinition, Claim, ResearchEvent } from "@finn/shared";
import { buildAlerts, buildRules, previewRule } from "./alerts";
import { allMockItems, buildDigest, type DigestWindow, type MockScenario } from "./digest";
import { buildEngine } from "./engine";
import { ALL_COMPANIES, PORTFOLIO, buildHoldings } from "./portfolio";
import { CDSL_ASK_ANSWERS, CDSL_DEFAULT_ANSWER } from "./research-cdsl";
import { getMockRun, getMockRunForSymbol, mockRunEventsSince, startMockRun } from "./runs";

function scenario(): MockScenario {
  if (typeof window === "undefined") return "default";
  const s = new URLSearchParams(window.location.search).get("scenario");
  return s === "stale" || s === "caughtup" ? s : "default";
}

const state: {
  rules: AlertRule[] | null;
  readAlerts: Set<string>;
  prefs: Record<string, unknown>;
} = { rules: null, readAlerts: new Set(), prefs: { defaultWindow: "24h" } };

function rules(): AlertRule[] {
  state.rules ??= buildRules(new Date());
  return state.rules;
}

export const mockApi = {
  digest: (window: DigestWindow) => buildDigest(new Date(), window, scenario()),
  announcement: (seqId: string) => allMockItems(new Date()).find((i) => i.id === seqId) ?? null,
  holdings: () => buildHoldings(new Date()),
  search: (q: string) => {
    const needle = q.trim().toUpperCase();
    if (!needle) return [];
    const inPortfolio = new Set(PORTFOLIO.map((p) => p.symbol));
    return ALL_COMPANIES.filter((c) => c.symbol.includes(needle) || c.name.toUpperCase().includes(needle))
      .sort((a, b) => Number(b.symbol.startsWith(needle)) - Number(a.symbol.startsWith(needle)))
      .slice(0, 8)
      .map((c) => ({
        symbol: c.symbol,
        name: c.name,
        statementFamily: c.family,
        inPortfolio: inPortfolio.has(c.symbol),
        researchReady: c.symbol === "CDSL",
      }));
  },
  startRun: (symbol: string) => startMockRun(symbol),
  getRun: (runId: string) => getMockRun(runId),
  researchForSymbol: (symbol: string) => ({ run: getMockRunForSymbol(symbol) }),
  eventsSince: (runId: string, lastId: number): ResearchEvent[] => mockRunEventsSince(runId, lastId),
  ask: (symbol: string, question: string): { answer: Claim[]; insufficientSources: boolean } => {
    if (symbol !== "CDSL") return { answer: [], insufficientSources: true };
    const hit = CDSL_ASK_ANSWERS.find((a) => a.match.test(question));
    return { answer: hit?.answer ?? CDSL_DEFAULT_ANSWER, insufficientSources: false };
  },
  alerts: () => buildAlerts(new Date()).map((a) => (state.readAlerts.has(a.id) ? { ...a, readAt: a.readAt ?? new Date().toISOString() } : a)),
  markAlertRead: (id: string) => {
    state.readAlerts.add(id);
  },
  rules: () => rules(),
  previewRule: (text: string) => previewRule(text, new Date()),
  createRule: (input: { name: string; definition: AlertRuleDefinition }): AlertRule => {
    const rule: AlertRule = { id: `rule-${Date.now().toString(36)}`, enabled: true, createdAt: new Date().toISOString(), ...input };
    state.rules = [rule, ...rules()];
    return rule;
  },
  updateRule: (id: string, patch: Partial<Pick<AlertRule, "enabled" | "name">>): AlertRule => {
    state.rules = rules().map((r) => (r.id === id ? { ...r, ...patch } : r));
    return state.rules.find((r) => r.id === id)!;
  },
  deleteRule: (id: string) => {
    state.rules = rules().filter((r) => r.id !== id);
  },
  engine: () => buildEngine(new Date(), scenario()),
  prefs: () => state.prefs,
  savePrefs: (prefs: Record<string, unknown>) => {
    state.prefs = { ...state.prefs, ...prefs };
    return state.prefs;
  },
  vapidKey: () => ({ publicKey: "mock-vapid-public-key" }),
};

export type MockApi = typeof mockApi;
