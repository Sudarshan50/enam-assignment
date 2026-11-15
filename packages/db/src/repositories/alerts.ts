import type postgres from "postgres";
import { AlertRuleDefinitionSchema, type AlertRuleDefinition } from "@finn/shared/contracts/alerts";
import type { Sql } from "../client";

export type AlertKind = AlertRuleDefinition["type"];

export interface AlertRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  definition: AlertRuleDefinition;
  createdAt: Date;
}

export interface AlertInsert {
  ruleId: string;
  symbol: string;
  kind: AlertKind;
  eventKey: string;
  title: string;
  body: string;
  sessionDate: string | null;
  announcementSeqId: string | null;
}

export interface AlertRow {
  id: string;
  ruleId: string;
  ruleName: string;
  symbol: string;
  kind: AlertKind;
  eventKey: string;
  title: string;
  body: string;
  sessionDate: string | null;
  announcementSeqId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export function alertsRepo(sql: Sql) {
  const alertColumns = () => sql`
    a.id, a.rule_id AS "ruleId", r.name AS "ruleName", a.symbol, a.kind, a.event_key AS "eventKey", a.title, a.body,
    a.session_date::text AS "sessionDate", a.announcement_seq_id AS "announcementSeqId", a.read_at AS "readAt", a.created_at AS "createdAt"`;

  async function listRules(opts: { enabledOnly?: boolean } = {}): Promise<{ rules: AlertRuleRow[]; invalid: { id: string; error: string }[] }> {
    const rows = await sql<{ id: string; name: string; enabled: boolean; definition: unknown; createdAt: Date }[]>`
      SELECT id, name, enabled, definition, created_at AS "createdAt" FROM alert_rules
      ${opts.enabledOnly ? sql`WHERE enabled` : sql``}
      ORDER BY created_at`;
    const rules: AlertRuleRow[] = [];
    const invalid: { id: string; error: string }[] = [];
    for (const r of rows) {
      const parsed = AlertRuleDefinitionSchema.safeParse(r.definition);
      if (parsed.success) rules.push({ ...r, definition: parsed.data });
      else invalid.push({ id: r.id, error: parsed.error.message });
    }
    return { rules, invalid };
  }

  return {
    listRules,

    async getRule(id: string): Promise<AlertRuleRow | null> {
      const { rules } = await listRules();
      return rules.find((r) => r.id === id) ?? null;
    },

    async createRule(name: string, definition: AlertRuleDefinition): Promise<AlertRuleRow> {
      const [row] = await sql<AlertRuleRow[]>`
        INSERT INTO alert_rules (name, definition) VALUES (${name}, ${sql.json(definition as postgres.JSONValue)})
        RETURNING id, name, enabled, definition, created_at AS "createdAt"`;
      return row!;
    },

    async updateRule(id: string, patch: { name?: string; enabled?: boolean; definition?: AlertRuleDefinition }): Promise<boolean> {
      const res = await sql`
        UPDATE alert_rules SET
          name = COALESCE(${patch.name ?? null}, name),
          enabled = COALESCE(${patch.enabled ?? null}, enabled),
          definition = COALESCE(${patch.definition ? sql.json(patch.definition as postgres.JSONValue) : null}, definition)
        WHERE id = ${id}`;
      return (res.count ?? 0) > 0;
    },

    async deleteRule(id: string): Promise<boolean> {
      const res = await sql`DELETE FROM alert_rules WHERE id = ${id}`;
      return (res.count ?? 0) > 0;
    },

    /**
     * Inserts alerts idempotently on (rule_id, symbol, kind, event_key). Returns only the rows that
     * were actually new, so re-running a pipeline never re-notifies.
     */
    async insertMany(alerts: readonly AlertInsert[]): Promise<{ id: string; ruleId: string; symbol: string; kind: AlertKind; eventKey: string }[]> {
      const created: { id: string; ruleId: string; symbol: string; kind: AlertKind; eventKey: string }[] = [];
      for (const a of alerts) {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO alerts (rule_id, symbol, kind, event_key, title, body, session_date, announcement_seq_id)
          VALUES (${a.ruleId}, ${a.symbol}, ${a.kind}, ${a.eventKey}, ${a.title}, ${a.body}, ${a.sessionDate}, ${a.announcementSeqId})
          ON CONFLICT (rule_id, symbol, kind, event_key) DO NOTHING
          RETURNING id`;
        if (row) created.push({ id: row.id, ruleId: a.ruleId, symbol: a.symbol, kind: a.kind, eventKey: a.eventKey });
      }
      return created;
    },

    async list(opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<AlertRow[]> {
      return sql<AlertRow[]>`
        SELECT ${alertColumns()} FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
        ${opts.unreadOnly ? sql`WHERE a.read_at IS NULL` : sql``}
        ORDER BY a.created_at DESC LIMIT ${opts.limit ?? 100}`;
    },

    async get(id: string): Promise<AlertRow | null> {
      const [row] = await sql<AlertRow[]>`SELECT ${alertColumns()} FROM alerts a JOIN alert_rules r ON r.id = a.rule_id WHERE a.id = ${id}`;
      return row ?? null;
    },

    async markRead(id: string): Promise<boolean> {
      const res = await sql`UPDATE alerts SET read_at = now() WHERE id = ${id} AND read_at IS NULL`;
      return (res.count ?? 0) > 0;
    },

    async unreadCountBySymbol(): Promise<Record<string, number>> {
      const rows = await sql<{ symbol: string; n: number }[]>`
        SELECT symbol, count(*)::int AS n FROM alerts WHERE read_at IS NULL GROUP BY symbol`;
      return Object.fromEntries(rows.map((r) => [r.symbol, r.n]));
    },

    async count(): Promise<number> {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM alerts`;
      return row?.n ?? 0;
    },
  };
}

export type AlertsRepo = ReturnType<typeof alertsRepo>;
