import { z } from "zod";
import type { AppConfig } from "./deps";
import type { ResponseValidationMode } from "./http/respond";
import { DEFAULT_SSE_OPTIONS } from "./services/researchEventStream";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(4),

  JOBS_SECRET: z.string().min(8, "JOBS_SECRET must be at least 8 characters"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  TRUST_PROXY: z.string().default("1"),
  RESPONSE_VALIDATION: z.enum(["strict", "warn", "off"]).optional(),

  RESEARCH_RUNS_PER_DAY: z.coerce.number().int().min(0).default(40),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
  ASK_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(6),
  RESEARCH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),

  LLM_BASE_URL: z.string().url().default("https://inference.hyde.tech/v1"),
  LLM_API_KEY: optionalString,
  LLM_MODEL: z.string().default("hyde/glm-5.3-flash"),
  LLM_DAILY_CALL_BUDGET: z.coerce.number().int().min(0).default(2000),

  CLOUDFLARE_ACCOUNT_ID: optionalString,
  CLOUDFLARE_API_TOKEN: optionalString,
  EMBEDDING_MODEL: z.string().default("@cf/google/embeddinggemma-2"),
  EMBEDDING_DIMS: z.coerce.number().int().default(768),

  GITHUB_DISPATCH_TOKEN: optionalString,
  GITHUB_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default("Sudarshan50/enam-assignment"),
  GITHUB_RESEARCH_WORKFLOW: z.string().default("research.yml"),
  GITHUB_REF: z.string().default("main"),

  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid API environment:\n${problems}`);
  }
  return parsed.data;
}

function parseTrustProxy(value: string): number | boolean | string {
  if (value === "true") return true;
  if (value === "false") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function toAppConfig(config: Config): AppConfig {
  const isProduction = config.NODE_ENV === "production";
  const responseValidation: ResponseValidationMode =
    config.RESPONSE_VALIDATION ?? (isProduction ? "off" : config.NODE_ENV === "test" ? "strict" : "warn");
  const minute = 60_000;
  return {
    jobsSecret: config.JOBS_SECRET,
    corsOrigins: config.CORS_ORIGIN.split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean),
    isProduction,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    jsonLimit: "32kb",
    rateLimits: {
      global: { windowMs: minute, limit: config.RATE_LIMIT_PER_MIN },
      ask: { windowMs: minute, limit: config.ASK_RATE_LIMIT_PER_MIN },
      research: { windowMs: minute, limit: config.RESEARCH_RATE_LIMIT_PER_MIN },
    },
    responseValidation,
    sse: DEFAULT_SSE_OPTIONS,
  };
}
