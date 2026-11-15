import { pino } from "pino";
import { createApp } from "../src/app";
import type { AppConfig, AppServices } from "../src/deps";
import { JobRegistry } from "../src/services/jobs";

export const TOKEN = "test-demo-token-123";
export const JOBS_SECRET = "test-jobs-secret-456";
export const ORIGIN = "http://localhost:3000";
export const auth = { "x-finn-access": TOKEN };

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    jobsSecret: JOBS_SECRET,
    corsOrigins: [ORIGIN],
    isProduction: false,
    trustProxy: 1,
    jsonLimit: "32kb",
    rateLimits: {
      global: { windowMs: 60_000, limit: 10_000 },
      ask: { windowMs: 60_000, limit: 10_000 },
      research: { windowMs: 60_000, limit: 10_000 },
    },
    responseValidation: "strict",
    sse: { pollMs: 10, heartbeatMs: 1_000, maxDurationMs: 5_000, retryMs: 1_000 },
    ...overrides,
  };
}

/** Any service a test did not provide throws when used, so accidental calls are loud. */
function unstubbed(name: string): never {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        return () => {
          throw new Error(`${name}.${String(prop)} was called but not stubbed`);
        };
      },
    },
  ) as never;
}

export function buildTestApp(services: Partial<AppServices> = {}, config: Partial<AppConfig> = {}, shutdownSignal?: AbortSignal) {
  const defaults: AppServices = {
    health: { check: async () => ({ ok: true, db: "up", latencyMs: 1, uptimeS: 1 }) },
    digest: unstubbed("digest"),
    announcements: unstubbed("announcements"),
    interactions: unstubbed("interactions"),
    holdings: { list: async () => [] },
    companies: unstubbed("companies"),
    research: unstubbed("research"),
    researchEvents: unstubbed("researchEvents"),
    ask: unstubbed("ask"),
    llmBudget: { remaining: async () => 100 },
    alertRules: unstubbed("alertRules"),
    alerts: unstubbed("alerts"),
    push: unstubbed("push"),
    prefs: unstubbed("prefs"),
    engine: unstubbed("engine"),
    jobs: new JobRegistry(),
  };
  return createApp({ config: testConfig(config), logger: pino({ level: "silent" }), services: { ...defaults, ...services }, shutdownSignal });
}

export const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
