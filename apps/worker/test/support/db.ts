import postgres from "postgres";
import type { Sql } from "@finn/db";
import type { TestScope } from "./scope";

const URL = process.env.DATABASE_URL ?? "postgres://finn:finn@localhost:54329/finn";

/** A private pool (not the getDb singleton); null when the database is unreachable so suites can skip. */
export async function connectTestDb(): Promise<Sql | null> {
  const sql = postgres(URL, { max: 3, prepare: false, onnotice: () => {}, connect_timeout: 3, idle_timeout: 5, types: { bigint: postgres.BigInt } });
  try {
    await sql`SELECT 1`;
    return sql as unknown as Sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    return null;
  }
}

/** Deletes every row this test file could have created. Only touches rows carrying the file's prefixes. */
export async function cleanupScope(sql: Sql, s: TestScope): Promise<void> {
  if (!s.symbol.startsWith("ZTD") || !s.seq.startsWith("ztd")) throw new Error("refusing to clean up outside the ZTD prefix");
  const sym = `${s.symbol}%`;
  await sql`DELETE FROM alert_rules WHERE name LIKE ${`${s.rule}%`}`;
  await sql`DELETE FROM alerts WHERE symbol LIKE ${sym}`;
  await sql`DELETE FROM push_subscriptions WHERE endpoint LIKE ${`${s.endpoint}%`}`;
  await sql`DELETE FROM announcements WHERE seq_id LIKE ${`${s.seq}%`} OR symbol LIKE ${sym}`;
  await sql`DELETE FROM quarterly_filings WHERE seq_id LIKE ${`${s.seq}%`} OR symbol LIKE ${sym}`;
  await sql`DELETE FROM prices_eod WHERE symbol LIKE ${sym}`;
  await sql`DELETE FROM companies WHERE symbol LIKE ${sym}`;
  await sql`DELETE FROM source_health WHERE source LIKE ${`${s.source}%`}`;
  await sql`DELETE FROM ingestion_watermarks WHERE source LIKE ${`${s.source}%`}`;
}

export async function insertCompany(
  sql: Sql,
  symbol: string,
  opts: { name?: string; tracked?: boolean; holding?: boolean; family?: "industrial" | "banking" | "nbfc" | null } = {},
): Promise<void> {
  const tracked = opts.tracked ?? true;
  await sql`
    INSERT INTO companies (symbol, name, statement_family, screener_slug)
    VALUES (${symbol}, ${opts.name ?? `${symbol} Test Ltd`}, ${opts.family === undefined ? "industrial" : opts.family}, ${tracked ? `ztd-${symbol.toLowerCase()}` : null})
    ON CONFLICT (symbol) DO NOTHING`;
  if (opts.holding) await sql`INSERT INTO holdings (symbol) VALUES (${symbol}) ON CONFLICT DO NOTHING`;
}
