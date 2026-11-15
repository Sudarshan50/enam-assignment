import { pino } from "pino";
import { vi } from "vitest";
import type { z } from "zod";
import { type Sql, closeDb, getDb } from "@finn/db";
import { DispatchError, type WorkerDispatcher } from "../../src/adapters/workerDispatcher";
import { createApp } from "../../src/app";
import { type Config, loadConfig } from "../../src/config";
import { buildContainer } from "../../src/container";
import type { AppConfig, AppDeps, AppServices } from "../../src/deps";
import { createResearchRepository } from "../../src/repositories/research";
import { type AskEngine, createAskService } from "../../src/services/askService";
import { JobRegistry } from "../../src/services/jobs";
import { type ResearchRepository, createResearchService } from "../../src/services/researchService";
import type { Clock } from "../../src/lib/time";
import { JOBS_SECRET, TOKEN, silentLog } from "../helpers";

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://finn:finn@localhost:54329/finn";

/** Synthetic rows written by this suite start with this prefix; other suites use ZTD / ZTA. */
export const PREFIX = "ZTP";

/** True when the local database answers; DB suites skip otherwise. Never points at a remote DB. */
export async function dbReachable(): Promise<boolean> {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) return false;
  try {
    const sql = getDb({ url: DATABASE_URL, max: 4 });
    await Promise.race([
      sql`SELECT 1 FROM companies LIMIT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    return true;
  } catch {
    await closeDb().catch(() => {});
    return false;
  }
}

export function testEnv(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL,
    DEMO_ACCESS_TOKEN: TOKEN,
    JOBS_SECRET,
    RESEARCH_RUNS_PER_DAY: "100000",
    ...overrides,
  });
}

const OPEN = { windowMs: 60_000, limit: 100_000 };
export const openLimits: AppConfig["rateLimits"] = { global: OPEN, ask: OPEN, research: OPEN };

export type FakeDispatcher = WorkerDispatcher & { dispatchResearch: ReturnType<typeof vi.fn>; fail: boolean };

export function fakeDispatcher(fail = false): FakeDispatcher {
  const d: FakeDispatcher = {
    kind: "github",
    fail,
    dispatchResearch: vi.fn(async () => {
      if (d.fail) throw new DispatchError("GitHub dispatch returned 503: unavailable", 503);
    }),
  };
  return d;
}

export interface DbAppOptions {
  env?: Record<string, string>;
  config?: Partial<AppConfig>;
  dispatcher?: FakeDispatcher;
  /** Defaults to an engine that says the sources are insufficient. */
  askEngine?: AskEngine;
  runsPerDay?: number;
  clock?: Clock;
  /** Wraps the real research repository (e.g. to scope the stale-run scan to this suite's rows). */
  wrapRepo?: (repo: ResearchRepository) => ResearchRepository;
  services?: Partial<AppServices>;
}

/**
 * The real container (repositories, services, agent modules) on `sql`, with the worker dispatcher,
 * the Ask engine and the job registry replaced by fakes so nothing leaves the machine.
 */
export async function buildDbApp(sql: Sql, opts: DbAppOptions = {}) {
  const env = testEnv(opts.env);
  const container = await buildContainer(env, { logger: pino({ level: "silent" }), sql });
  const dispatcher = opts.dispatcher ?? fakeDispatcher();
  const realRepo = createResearchRepository(sql);
  const repo = opts.wrapRepo ? opts.wrapRepo(realRepo) : realRepo;
  const research = createResearchService({
    repo,
    dispatcher,
    runsPerDay: opts.runsPerDay ?? env.RESEARCH_RUNS_PER_DAY,
    now: opts.clock,
    log: silentLog,
  });
  const engine: AskEngine = opts.askEngine ?? { answer: async () => ({ answer: [], insufficientSources: true }) };
  const ask = createAskService({ engine, companyExists: async (s) => (await realRepo.findCompany(s)) !== null });
  const jobs = new JobRegistry([
    { name: "dispatch-research", description: "Re-dispatch stale research runs (suite-scoped)", run: () => research.redispatchStale() },
  ]);
  const deps: AppDeps = {
    ...container.deps,
    config: { ...container.deps.config, rateLimits: openLimits, ...opts.config },
    services: { ...container.deps.services, research, ask, jobs, ...opts.services },
  };
  return { app: createApp(deps), deps, container, dispatcher, research, repo: realRepo };
}

class Rollback extends Error {}

/** Runs `fn` inside a transaction that is always rolled back, so nothing it writes is ever visible to others. */
export async function inRollback<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await sql.begin(async (tx) => {
      result = await fn(tx as unknown as Sql);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result as T;
}

/** Parses with a schema and fails with readable issues instead of a bare "false". */
export function expectParse<S extends z.ZodType>(schema: S, value: unknown, label = "response"): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${label} does not match its schema:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

export async function insertCompany(sql: Sql, symbol: string, opts: { name?: string; family?: string | null; holding?: boolean } = {}) {
  await sql`
    INSERT INTO companies (symbol, name, statement_family)
    VALUES (${symbol}, ${opts.name ?? `${symbol} Test Ltd`}, ${opts.family ?? null})
    ON CONFLICT (symbol) DO NOTHING`;
  if (opts.holding) await sql`INSERT INTO holdings (symbol) VALUES (${symbol}) ON CONFLICT DO NOTHING`;
}

/**
 * Removes committed rows whose symbol / name / endpoint starts with `prefix` (always a ZTP… prefix).
 * research_runs and prices_eod have no FK to companies, so they are deleted explicitly.
 */
export async function cleanupPrefix(sql: Sql, prefix: string) {
  if (!prefix.startsWith(PREFIX)) throw new Error(`refusing to clean up non-${PREFIX} prefix ${prefix}`);
  const like = `${prefix}%`;
  await sql`DELETE FROM research_runs WHERE symbol LIKE ${like}`;
  await sql`DELETE FROM prices_eod WHERE symbol LIKE ${like}`;
  await sql`DELETE FROM alerts WHERE symbol LIKE ${like}`;
  await sql`DELETE FROM alert_rules WHERE name LIKE ${like}`;
  await sql`DELETE FROM push_subscriptions WHERE endpoint LIKE ${`https://push.example.test/${prefix}%`}`;
  await sql`DELETE FROM holdings WHERE symbol LIKE ${like}`;
  await sql`DELETE FROM companies WHERE symbol LIKE ${like}`;
}
