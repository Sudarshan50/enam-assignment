import type { Sql } from "@finn/db";

type JsonParam = Parameters<Sql["json"]>[0];

/** postgres.js types `sql.json` narrowly; every caller here passes plain JSON-serialisable data. */
export function json(sql: Sql, value: unknown) {
  return sql.json(value as JsonParam);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
