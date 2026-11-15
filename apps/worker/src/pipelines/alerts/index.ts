import {
  createScopeResolver,
  evaluateCategoryRule,
  evaluatePriceRules,
  type AlertDraft,
  type AnnouncementForAlert,
  type ScopeResolver,
} from "@finn/domain/alerts/evaluate";
import type { Sql } from "@finn/db";
import { alertsRepo } from "@finn/db/repositories/alerts";
import { announcementsRepo } from "@finn/db/repositories/announcements";
import { companiesRepo } from "@finn/db/repositories/companies";
import { pricesRepo } from "@finn/db/repositories/prices";
import { argIsoDate } from "../../args";
import type { Command, WorkerContext } from "../../context";
import { deliverPendingPushes, type DeliverySummary } from "../../notify/webPush";
import { addDays, istDayStart } from "../../time";

/** A bonus/split filed within this many days before the session (or that day) suppresses price alerts. */
const SPLIT_SUPPRESSION_DAYS = 7;

export interface AlertRunSummary {
  sessionDate: string | null;
  evaluated: number;
  drafts: number;
  created: number;
  push: DeliverySummary | null;
}

async function scopeResolver(sql: Sql): Promise<ScopeResolver> {
  const companies = companiesRepo(sql);
  const [holdings, families] = await Promise.all([companies.listHoldingSymbols(), companies.familyMap()]);
  return createScopeResolver({ holdings, familyOf: (s) => families.get(s) ?? null });
}

async function insertDrafts(sql: Sql, drafts: AlertDraft[]) {
  return alertsRepo(sql).insertMany(
    drafts.map((d) => ({
      ruleId: d.ruleId,
      symbol: d.symbol,
      kind: d.kind,
      eventKey: d.eventKey,
      title: d.title,
      body: d.body,
      sessionDate: d.sessionDate,
      announcementSeqId: d.announcementSeqId,
    })),
  );
}

/** Evaluates price and volume rules against one session. Re-running is a no-op thanks to the alerts unique key. */
export async function runPriceAlerts(ctx: WorkerContext, opts: { sessionDate?: string; push?: boolean } = {}): Promise<AlertRunSummary> {
  const prices = pricesRepo(ctx.sql);
  const sessionDate = opts.sessionDate ?? (await prices.latestSessionDate());
  if (!sessionDate) return { sessionDate: null, evaluated: 0, drafts: 0, created: 0, push: null };

  const { rules, invalid } = await alertsRepo(ctx.sql).listRules({ enabledOnly: true });
  for (const bad of invalid) ctx.log.warn(bad, "Skipping alert rule with invalid definition");

  const rows = await prices.forSession(sessionDate);
  const snapshots = rows.map((r) => ({
    symbol: r.symbol,
    sessionDate: r.sessionDate,
    close: r.close,
    prevClose: r.prevClose,
    volume: r.volume,
    avg20Volume: r.avg20Volume,
  }));
  const suppressed = new Set(
    await announcementsRepo(ctx.sql).symbolsWithCategoryBetween(
      "bonus_split",
      istDayStart(addDays(sessionDate, -SPLIT_SUPPRESSION_DAYS)),
      istDayStart(addDays(sessionDate, 1)),
    ),
  );
  const drafts = evaluatePriceRules(rules, snapshots, await scopeResolver(ctx.sql), { suppressedSymbols: suppressed });
  const created = await insertDrafts(ctx.sql, drafts);
  const push = opts.push === false ? null : await deliverPendingPushes(ctx);
  return { sessionDate, evaluated: snapshots.length, drafts: drafts.length, created: created.length, push };
}

/** Category rules for freshly processed filings; event key is the cluster, so duplicates alert once. */
export async function runCategoryAlerts(ctx: WorkerContext, announcements: readonly AnnouncementForAlert[]): Promise<number> {
  if (announcements.length === 0) return 0;
  const { rules } = await alertsRepo(ctx.sql).listRules({ enabledOnly: true });
  const categoryRules = rules.filter((r) => r.definition.type === "category");
  if (categoryRules.length === 0) return 0;
  const inScope = await scopeResolver(ctx.sql);
  const drafts: AlertDraft[] = [];
  for (const a of announcements) {
    for (const rule of categoryRules) {
      const d = evaluateCategoryRule(rule, a, inScope);
      if (d) drafts.push(d);
    }
  }
  return (await insertDrafts(ctx.sql, drafts)).length;
}

export const alertsCommand: Command = {
  name: "alerts",
  description: "Re-evaluate price/volume alert rules for a session without fetching prices (--date YYYY-MM-DD, default latest)",
  async run(ctx, args) {
    const summary = await runPriceAlerts(ctx, { sessionDate: argIsoDate(args, "date") });
    ctx.log.info(summary, "Alerts evaluated");
  },
};
