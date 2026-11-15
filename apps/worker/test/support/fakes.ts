import { readFileSync } from "node:fs";
import type { Sql } from "@finn/db";
import type { AnnouncementClassifier, CardEnricher, ClassificationInput, ClassificationResult, EnrichmentInput, LlmPort } from "@finn/shared/ports";
import { HttpError, type HttpClient } from "@finn/sources/http/client";
import type { Logger, WorkerContext } from "../../src/context";

export const SOURCES_FIXTURES = new URL("../../../../packages/sources/test/fixtures/", import.meta.url);
export const FINANCIALS_FIXTURES = new URL("../../../../packages/financials/test/fixtures/", import.meta.url);

export const readSourcesFixture = (name: string) => readFileSync(new URL(name, SOURCES_FIXTURES), "utf8");
export const readSourcesFixtureBytes = (name: string) => new Uint8Array(readFileSync(new URL(name, SOURCES_FIXTURES)));
export const readXbrlFixture = (name: string) => readFileSync(new URL(name, FINANCIALS_FIXTURES), "utf8");

type Body = string | Uint8Array | object;
type Responder = Body | ((url: string) => Body | Promise<Body>);

/**
 * In-memory HttpClient. Routes are tried in order: a string matches by URL prefix, a RegExp by test.
 * A responder that throws simulates an outage; unmatched URLs answer 404 like NSE does for missing files.
 */
export function fakeHttp() {
  const routes: { match: string | RegExp; respond: Responder }[] = [];
  const calls: string[] = [];
  const find = async (url: string): Promise<Body> => {
    calls.push(url);
    const route = routes.find((r) => (typeof r.match === "string" ? url.startsWith(r.match) : r.match.test(url)));
    if (!route) throw new HttpError(`HTTP 404 for ${url}`, url, 404);
    return typeof route.respond === "function" ? route.respond(url) : route.respond;
  };
  const http: HttpClient & {
    calls: string[];
    route(match: string | RegExp, respond: Responder): void;
    reset(): void;
  } = {
    calls,
    route(match, respond) {
      routes.unshift({ match, respond });
    },
    reset() {
      routes.length = 0;
      calls.length = 0;
    },
    isAllowed: (url) => /^https:\/\/([a-z0-9-]+\.)*(nseindia\.(com|in)|yahoo\.com)\//i.test(url),
    async getJson<T>(url: string) {
      const body = await find(url);
      if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body)) as T;
      return (typeof body === "string" ? JSON.parse(body) : body) as T;
    },
    async getText(url) {
      const body = await find(url);
      if (body instanceof Uint8Array) return new TextDecoder().decode(body);
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async getBuffer(url) {
      const body = await find(url);
      if (body instanceof Uint8Array) return body;
      return new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
    },
  };
  return http;
}

export const outage = (status = 503) => (url: string): never => {
  throw new HttpError(`HTTP ${status} for ${url}`, url, status);
};

export interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  obj: object | string;
  msg?: string;
}

export function recordingLogger(): Logger & { entries: LogEntry[]; messages(level?: LogEntry["level"]): string[] } {
  const entries: LogEntry[] = [];
  const at = (level: LogEntry["level"]) => (obj: object | string, msg?: string) => {
    entries.push({ level, obj, msg });
  };
  return {
    entries,
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
    messages: (level) => entries.filter((e) => !level || e.level === level).map((e) => e.msg ?? (typeof e.obj === "string" ? e.obj : "")),
  };
}

export function fakeClassifier(impl?: (input: ClassificationInput) => ClassificationResult | Promise<ClassificationResult>) {
  const calls: ClassificationInput[] = [];
  const classifier: AnnouncementClassifier & { calls: ClassificationInput[]; impl: typeof impl } = {
    calls,
    impl,
    async classify(input) {
      calls.push(input);
      if (!classifier.impl) return { category: "press_release", impact: 1.2, confidence: 0.85, oneLiner: `LLM: ${input.subject}`, reasonCodes: ["fake"] };
      return classifier.impl(input);
    },
  };
  return classifier;
}

export function fakeEnricher(impl?: (input: EnrichmentInput) => ReturnType<CardEnricher["enrich"]>) {
  const calls: EnrichmentInput[] = [];
  const enricher: CardEnricher & { calls: EnrichmentInput[]; impl: typeof impl } = {
    calls,
    impl,
    async enrich(input) {
      calls.push(input);
      if (!enricher.impl) return { kind: "generic", oneLiner: `enriched ${input.seqId}` };
      return enricher.impl(input);
    },
  };
  return enricher;
}

const noLlm: LlmPort = { complete: () => Promise.reject(new Error("LLM is not available in tests")) };

export function fakeContext(sql: Sql, overrides: Partial<WorkerContext> = {}) {
  const log = recordingLogger();
  const classifier = fakeClassifier();
  const enricher = fakeEnricher();
  const http = fakeHttp();
  const ctx = {
    sql,
    http,
    llm: noLlm,
    embeddings: {
      model: "fake",
      dims: 768,
      embedDocuments: () => Promise.reject(new Error("no embeddings in tests")),
      embedQuery: () => Promise.reject(new Error("no embeddings in tests")),
    },
    classifier,
    enricher,
    log,
    env: {},
    ...overrides,
  } satisfies WorkerContext;
  return { ctx, log, classifier, enricher, http };
}

/** Today's IST date (YYYY-MM-DD) shifted by `days`. */
export function istDate(days = 0, now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** NSE "DD-Mon-YYYY" for an ISO date. */
export function nseDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}
