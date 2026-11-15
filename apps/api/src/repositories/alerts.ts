import type { Sql } from "@finn/db";
import type { AlertRepository, AlertRow, AlertRuleRow } from "../services/alertRuleService";
import type { PricePoint } from "../services/holdingsService";
import { json } from "./sql";

const RULE_COLUMNS = (sql: Sql) => sql`id, name, enabled, definition, created_at AS "createdAt"`;

export function createAlertsRepository(sql: Sql): AlertRepository {
  return {
    async listRules() {
      return sql<AlertRuleRow[]>`SELECT ${RULE_COLUMNS(sql)} FROM alert_rules ORDER BY created_at`;
    },

    async getRule(id) {
      const [row] = await sql<AlertRuleRow[]>`SELECT ${RULE_COLUMNS(sql)} FROM alert_rules WHERE id = ${id}`;
      return row ?? null;
    },

    async insertRule(name, definition) {
      const [row] = await sql<AlertRuleRow[]>`
        INSERT INTO alert_rules (name, definition) VALUES (${name}, ${json(sql, definition)})
        RETURNING ${RULE_COLUMNS(sql)}`;
      if (!row) throw new Error("alert rule insert returned nothing");
      return row;
    },

    async updateRule(id, patch) {
      const [row] = await sql<AlertRuleRow[]>`
        UPDATE alert_rules SET
          name = COALESCE(${patch.name ?? null}, name),
          enabled = COALESCE(${patch.enabled ?? null}::boolean, enabled),
          definition = COALESCE(${patch.definition ? json(sql, patch.definition) : null}::jsonb, definition)
        WHERE id = ${id}
        RETURNING ${RULE_COLUMNS(sql)}`;
      return row ?? null;
    },

    async deleteRule(id) {
      const rows = await sql`DELETE FROM alert_rules WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    },

    async listAlerts(limit) {
      return sql<AlertRow[]>`
        SELECT a.id, a.rule_id AS "ruleId", r.name AS "ruleName", a.symbol, a.kind, a.title, a.body,
               a.session_date::text AS "sessionDate", a.announcement_seq_id AS "announcementId",
               a.created_at AS "createdAt", a.read_at AS "readAt"
        FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
        ORDER BY a.created_at DESC
        LIMIT ${limit}`;
    },

    async markAlertRead(id) {
      const rows = await sql`UPDATE alerts SET read_at = COALESCE(read_at, now()) WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    },

    async listHoldings() {
      return sql<{ symbol: string; statementFamily: string | null }[]>`
        SELECT h.symbol, c.statement_family AS "statementFamily"
        FROM holdings h JOIN companies c ON c.symbol = h.symbol ORDER BY h.symbol`;
    },

    async existingSymbols(symbols) {
      if (symbols.length === 0) return [];
      const rows = await sql<{ symbol: string }[]>`SELECT symbol FROM companies WHERE symbol = ANY(${symbols}::text[]) ORDER BY symbol`;
      return rows.map((r) => r.symbol);
    },

    async allSymbols() {
      const rows = await sql<{ symbol: string }[]>`SELECT symbol FROM companies`;
      return rows.map((r) => r.symbol);
    },

    async priceSeries(symbols, sessions) {
      const series = new Map<string, PricePoint[]>();
      if (symbols.length === 0) return series;
      const rows = await sql<(PricePoint & { symbol: string })[]>`
        SELECT symbol, "sessionDate", close, "prevClose", volume, "avg20Volume" FROM (
          SELECT p.symbol, p.session_date::text AS "sessionDate", p.close::float8 AS close, p.prev_close::float8 AS "prevClose",
                 p.volume::float8 AS volume, p.avg20_volume::float8 AS "avg20Volume",
                 row_number() OVER (PARTITION BY p.symbol ORDER BY p.session_date DESC) AS rn
          FROM prices_eod p WHERE p.symbol = ANY(${symbols}::text[])
        ) recent
        WHERE rn <= ${sessions}
        ORDER BY symbol, "sessionDate"`;
      for (const { symbol, ...point } of rows) {
        const list = series.get(symbol) ?? [];
        list.push(point);
        series.set(symbol, list);
      }
      return series;
    },

    async bonusSplitDates(symbols, since) {
      const out = new Map<string, Set<string>>();
      if (symbols.length === 0) return out;
      const rows = await sql<{ symbol: string; d: string }[]>`
        SELECT symbol, (published_at AT TIME ZONE 'Asia/Kolkata')::date::text AS d
        FROM announcements
        WHERE category = 'bonus_split' AND symbol = ANY(${symbols}::text[]) AND published_at >= ${since}`;
      for (const r of rows) out.set(r.symbol, (out.get(r.symbol) ?? new Set()).add(r.d));
      return out;
    },

    async categoryFilings(symbols, categories, since) {
      if (symbols.length === 0 || categories.length === 0) return [];
      return sql<{ symbol: string; count: number; last: string | null }[]>`
        SELECT symbol, count(*)::int AS count, max((published_at AT TIME ZONE 'Asia/Kolkata')::date)::text AS last
        FROM announcements
        WHERE parent_seq_id IS NULL AND status = 'ready'
          AND category = ANY(${categories}::text[]) AND symbol = ANY(${symbols}::text[]) AND published_at >= ${since}
        GROUP BY symbol`;
    },
  };
}
