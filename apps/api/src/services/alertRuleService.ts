import { type Alert, type AlertRule, type AlertRuleDefinition, AlertRuleDefinitionSchema } from "@finn/shared";
import type { Backtest, PreviewResponse, UpdateAlertRule } from "../contracts";
import { badRequest, notFound } from "../http/errors";
import type { Logger } from "../lib/logger";
import { type Clock, DAY, systemClock, toIso, toIsoRequired } from "../lib/time";
import { BACKTEST_SESSIONS, backtestPriceRule, describeBacktest } from "./alertBacktest";
import type { PricePoint } from "./holdingsService";

export interface AlertRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  definition: unknown;
  createdAt: Date;
}

export interface AlertRow {
  id: string;
  ruleId: string;
  ruleName: string;
  symbol: string;
  kind: "price_move" | "volume_spike" | "category";
  title: string;
  body: string;
  sessionDate: string | null;
  announcementId: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export interface AlertRepository {
  listRules(): Promise<AlertRuleRow[]>;
  getRule(id: string): Promise<AlertRuleRow | null>;
  insertRule(name: string, definition: AlertRuleDefinition): Promise<AlertRuleRow>;
  updateRule(id: string, patch: { name?: string; enabled?: boolean; definition?: AlertRuleDefinition }): Promise<AlertRuleRow | null>;
  deleteRule(id: string): Promise<boolean>;
  listAlerts(limit: number): Promise<AlertRow[]>;
  markAlertRead(id: string): Promise<boolean>;
  listHoldings(): Promise<{ symbol: string; statementFamily: string | null }[]>;
  existingSymbols(symbols: string[]): Promise<string[]>;
  allSymbols(): Promise<string[]>;
  /** Up to `sessions` most recent EOD rows per symbol, oldest first. */
  priceSeries(symbols: string[], sessions: number): Promise<Map<string, PricePoint[]>>;
  bonusSplitDates(symbols: string[], since: Date): Promise<Map<string, Set<string>>>;
  categoryFilings(symbols: string[], categories: string[], since: Date): Promise<{ symbol: string; count: number; last: string | null }[]>;
}

/** Deterministic text -> rule parser (implemented by @finn/domain/alerts/parseRuleText). */
export interface RuleParser {
  parse(text: string, ctx: { isKnownSymbol: (symbol: string) => boolean }): AlertRuleDefinition | null;
  explain(definition: AlertRuleDefinition): string;
}

export interface AlertRuleService {
  list(): Promise<AlertRule[]>;
  create(input: { name: string; definition: AlertRuleDefinition }): Promise<AlertRule>;
  update(id: string, patch: UpdateAlertRule): Promise<AlertRule>;
  remove(id: string): Promise<void>;
  preview(text: string): Promise<PreviewResponse>;
}

export interface AlertService {
  list(limit: number): Promise<Alert[]>;
  markRead(id: string): Promise<void>;
}

const UNPARSED_HELP =
  "I couldn't turn that into a rule. Try something like “tell me when any holding falls more than 4%”, “volume above 3x average for TCS” or “new results or rating changes for my banks”.";

function toRule(row: AlertRuleRow, log?: Logger): AlertRule | null {
  const def = AlertRuleDefinitionSchema.safeParse(row.definition);
  if (!def.success) {
    log?.warn({ ruleId: row.id }, "stored alert rule definition is invalid; hiding it");
    return null;
  }
  return { id: row.id, name: row.name, enabled: row.enabled, definition: def.data, createdAt: toIsoRequired(row.createdAt) };
}

export function withThreshold(def: AlertRuleDefinition, threshold: number): AlertRuleDefinition {
  if (def.type === "price_move") return AlertRuleDefinitionSchema.parse({ ...def, thresholdPct: threshold });
  if (def.type === "volume_spike") return AlertRuleDefinitionSchema.parse({ ...def, multiple: threshold });
  throw badRequest("Category rules have no threshold");
}

export function createAlertRuleService(deps: { repo: AlertRepository; parser: RuleParser; now?: Clock; log?: Logger }): AlertRuleService {
  const { repo, parser, log } = deps;
  const now = deps.now ?? systemClock;

  async function resolveScope(def: AlertRuleDefinition): Promise<string[]> {
    const scope = def.scope;
    if (scope.kind === "symbols") return repo.existingSymbols([...new Set(scope.symbols.map((s) => s.toUpperCase()))]);
    const holdings = await repo.listHoldings();
    if (scope.kind === "portfolio") return holdings.map((h) => h.symbol);
    return holdings.filter((h) => h.statementFamily === scope.family).map((h) => h.symbol);
  }

  async function backtest(def: AlertRuleDefinition, symbols: string[]): Promise<Backtest> {
    if (symbols.length === 0) return { sessions: 0, fires: 0, bySymbol: [], note: "No matching companies to replay." };
    // ~30 sessions of calendar time, for category rules and the split/bonus suppression lookup.
    const since = new Date(now().getTime() - 45 * DAY);
    if (def.type === "category") {
      const rows = await repo.categoryFilings(symbols, def.categories, since);
      const bySymbol = rows
        .filter((r) => r.count > 0)
        .map((r) => ({ symbol: r.symbol, fires: r.count, lastFiredOn: r.last }))
        .sort((a, b) => b.fires - a.fires || a.symbol.localeCompare(b.symbol));
      return { sessions: BACKTEST_SESSIONS, fires: bySymbol.reduce((s, r) => s + r.fires, 0), bySymbol, note: null };
    }
    const [series, suppressed] = await Promise.all([
      repo.priceSeries(symbols, BACKTEST_SESSIONS + 20),
      def.type === "price_move" ? repo.bonusSplitDates(symbols, since) : Promise.resolve(new Map<string, Set<string>>()),
    ]);
    return backtestPriceRule(def, series, suppressed);
  }

  return {
    async list() {
      return (await repo.listRules()).flatMap((r) => toRule(r, log) ?? []);
    },

    async create(input) {
      const row = await repo.insertRule(input.name, input.definition);
      const rule = toRule(row, log);
      if (!rule) throw new Error("Inserted rule failed validation");
      return rule;
    },

    async update(id, patch) {
      const current = await repo.getRule(id);
      if (!current) throw notFound("Alert rule");
      let definition: AlertRuleDefinition | undefined;
      if (patch.threshold !== undefined) {
        const parsed = AlertRuleDefinitionSchema.safeParse(current.definition);
        if (!parsed.success) throw badRequest("This rule's stored definition is invalid; recreate it");
        definition = withThreshold(parsed.data, patch.threshold);
      }
      const row = await repo.updateRule(id, { name: patch.name, enabled: patch.enabled, definition });
      const rule = row && toRule(row, log);
      if (!rule) throw notFound("Alert rule");
      return rule;
    },

    async remove(id) {
      if (!(await repo.deleteRule(id))) throw notFound("Alert rule");
    },

    async preview(text) {
      const known = new Set(await repo.allSymbols());
      const raw = parser.parse(text, { isKnownSymbol: (s) => known.has(s.toUpperCase()) });
      const parsed = raw ? AlertRuleDefinitionSchema.safeParse(raw) : null;
      if (!parsed?.success) return { definition: null, resolvedSymbols: [], explanation: UNPARSED_HELP, backtest: null };
      const definition = parsed.data;
      const resolvedSymbols = await resolveScope(definition);
      const result = await backtest(definition, resolvedSymbols);
      const replay =
        definition.type === "category"
          ? result.fires === 0
            ? "No matching filings in the last 30 sessions."
            : `${result.fires} matching filing${result.fires === 1 ? "" : "s"} in the last 30 sessions.`
          : describeBacktest(result);
      return { definition, resolvedSymbols, explanation: `${parser.explain(definition)} ${replay}`.trim(), backtest: result };
    },
  };
}

export function createAlertService(repo: AlertRepository): AlertService {
  return {
    async list(limit) {
      return (await repo.listAlerts(limit)).map((a) => ({
        id: a.id,
        ruleId: a.ruleId,
        ruleName: a.ruleName,
        symbol: a.symbol,
        kind: a.kind,
        title: a.title,
        body: a.body,
        sessionDate: a.sessionDate,
        announcementId: a.announcementId,
        createdAt: toIsoRequired(a.createdAt),
        readAt: toIso(a.readAt),
      }));
    },
    async markRead(id) {
      if (!(await repo.markAlertRead(id))) throw notFound("Alert");
    },
  };
}
