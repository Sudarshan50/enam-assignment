import postgres from "postgres";

export type Sql = postgres.Sql;

let instance: Sql | null = null;

export interface DbOptions {
  url?: string;
  max?: number;
}

/**
 * Shared connection pool. Keep `max` small: Supabase free tier shares ~60 connections
 * between the API, the worker and Supabase's own services.
 */
export function getDb(options: DbOptions = {}): Sql {
  if (instance) return instance;
  const url = options.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  instance = postgres(url, {
    max: options.max ?? Number(process.env.DB_POOL_MAX ?? 4),
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
    types: {
      bigint: postgres.BigInt,
    },
  });
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.end({ timeout: 5 });
    instance = null;
  }
}
