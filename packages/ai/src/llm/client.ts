import type { Sql } from "@finn/db";
import { IST_OFFSET_MS } from "@finn/shared/format";
import type { LlmPort, StructuredCompletionRequest } from "@finn/shared/ports";
import { backoffMs, sleep as realSleep } from "../util/concurrency";
import { parseModelJson } from "../util/json";
import { formatZodError } from "../util/schema";
import { createSqlLlmCache, llmCacheKey, type LlmCache } from "./cache";
import { CircuitBreaker } from "./circuitBreaker";
import { BudgetExceededError, LlmTransportError, LlmUnavailableError, LlmValidationError } from "./errors";
import { createSqlLedger, type LlmLedger } from "./ledger";
import { createOpenAiTransport, UnsupportedResponseFormatError, type ChatMessage, type ChatTransport, type ResponseFormat } from "./transport";

export { BudgetExceededError, LlmTransportError, LlmUnavailableError, LlmValidationError } from "./errors";

export interface LlmClientDeps {
  transport: ChatTransport;
  model: string;
  cache: LlmCache;
  ledger: LlmLedger;
  dailyCallBudget: number;
  provider?: string;
  /**
   * json_object (default) puts the schema in the system prompt; zod enforces it. Measured on GLM: strict
   * json_schema is accepted, but for nested schemas with nullable objects/arrays it returns the minimal valid
   * instance ({"description": null, "segments": []}) where json_object returns the real answer.
   */
  structuredOutput?: "json_schema" | "json_object";
  breaker?: CircuitBreaker;
  /** Total provider attempts per call, including the single validation re-ask. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface LlmClientOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  sql: Sql;
  dailyCallBudget: number;
  /** Override the provider transport (tests, alternative SDKs). */
  transport?: ChatTransport;
  structuredOutput?: "json_schema" | "json_object";
}

const MAX_ECHOED_RESPONSE_CHARS = 6_000;

/** Start of the current day in India time, as a UTC instant. */
export function istMidnight(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

function schemaName(task: string): string {
  return task.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "response";
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** In json_object mode GLM sometimes nests the answer one level down: {"<task>": {...}} or {"properties": {...}}. */
export function envelopeContent(json: unknown): unknown {
  if (!isPlainObject(json)) return undefined;
  if (isPlainObject(json.properties)) return json.properties;
  const keys = Object.keys(json);
  const only = keys.length === 1 ? json[keys[0]!] : undefined;
  return isPlainObject(only) ? only : undefined;
}

function isRetryableTransportError(err: unknown): boolean {
  if (!(err instanceof LlmTransportError)) return true;
  const s = err.status;
  return s === null || s === 408 || s === 409 || s === 429 || s >= 500;
}

export function createLlmClientFromDeps(deps: LlmClientDeps): LlmPort {
  const provider = deps.provider ?? "glm";
  const breaker = deps.breaker ?? new CircuitBreaker();
  const maxAttempts = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => new Date());
  let formatMode: "json_schema" | "json_object" = deps.structuredOutput ?? "json_object";

  async function assertBudget(): Promise<void> {
    const used = await deps.ledger.countBillableSince(istMidnight(now()), provider);
    if (used >= deps.dailyCallBudget) throw new BudgetExceededError(used, deps.dailyCallBudget);
  }

  function buildMessages<T>(req: StructuredCompletionRequest<T>, followUps: ChatMessage[]): { messages: ChatMessage[]; format: ResponseFormat } {
    if (formatMode === "json_schema") {
      return {
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }, ...followUps],
        format: { type: "json_schema", json_schema: { name: schemaName(req.task), strict: true, schema: req.jsonSchema } },
      };
    }
    const system = `${req.system}\n\nRespond with a single JSON object (no prose, no code fences) that validates against this JSON schema:\n${JSON.stringify(req.jsonSchema)}`;
    return {
      messages: [{ role: "system", content: system }, { role: "user", content: req.user }, ...followUps],
      format: { type: "json_object" },
    };
  }

  return {
    async complete<T>(req: StructuredCompletionRequest<T>): Promise<T> {
      const base = {
        provider,
        model: deps.model,
        task: req.task,
        promptVersion: req.promptVersion,
        refKind: req.ref?.kind ?? null,
        refId: req.ref?.id ?? null,
      };
      const key = llmCacheKey({
        model: deps.model,
        task: req.task,
        promptVersion: req.promptVersion,
        jsonSchema: req.jsonSchema,
        system: req.system,
        user: req.user,
        format: formatMode,
      });

      if (!req.noCache) {
        const hit = await deps.cache.get(key);
        if (hit !== undefined) {
          try {
            const value = req.parse(hit);
            await deps.ledger.record({ ...base, cacheHit: true, status: "cache_hit", schemaValid: true, latencyMs: 0 });
            return value;
          } catch {
            // A cached response that no longer validates (schema changed under the same version) is ignored.
          }
        }
      }

      const followUps: ChatMessage[] = [];
      let reasked = false;
      let lastError: Error = new LlmTransportError("No attempt made");

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await assertBudget();
        if (!breaker.tryAcquire()) throw new LlmUnavailableError(undefined, breaker.retryAfterMs());

        const { messages, format } = buildMessages(req, followUps);
        const started = Date.now();
        let content: string;
        let usage: { promptTokens: number | null; completionTokens: number | null };
        let cutOff: boolean;
        try {
          const res = await deps.transport.chat({
            model: deps.model,
            messages,
            responseFormat: format,
            maxTokens: req.maxTokens,
            temperature: req.temperature ?? 0,
          });
          content = res.content;
          usage = { promptTokens: res.promptTokens, completionTokens: res.completionTokens };
          cutOff = res.finishReason === "length" || (req.maxTokens !== undefined && res.completionTokens !== null && res.completionTokens >= req.maxTokens);
        } catch (err) {
          const latencyMs = Date.now() - started;
          if (err instanceof UnsupportedResponseFormatError && formatMode === "json_schema") {
            breaker.recordSuccess();
            formatMode = "json_object";
            await deps.ledger.record({ ...base, cacheHit: false, status: "error", error: `json_schema unsupported: ${err.message}`, latencyMs, attempt });
            continue;
          }
          breaker.recordFailure();
          lastError = err instanceof Error ? err : new LlmTransportError(String(err));
          await deps.ledger.record({ ...base, cacheHit: false, status: "error", error: lastError.message, latencyMs, attempt });
          if (!isRetryableTransportError(err)) throw lastError;
          if (attempt < maxAttempts) await sleep(backoffMs(attempt - 1));
          continue;
        }
        breaker.recordSuccess();
        const latencyMs = Date.now() - started;

        let json: unknown;
        let value: T;
        try {
          json = parseModelJson(content);
          try {
            value = req.parse(json);
          } catch (err) {
            const inner = envelopeContent(json);
            if (inner === undefined) throw err;
            try {
              value = req.parse(inner);
            } catch {
              throw err;
            }
            json = inner;
          }
        } catch (err) {
          const keys = isPlainObject(json) ? ` (top-level keys received: ${Object.keys(json).slice(0, 8).join(", ") || "none"})` : "";
          const reason = cutOff
            ? `response cut off at the ${req.maxTokens ?? "provider"} token limit before the JSON was complete`
            : err instanceof SyntaxError
              ? `invalid JSON (${err.message})`
              : `${formatZodError(err)}${keys}`;
          lastError = new LlmValidationError(`${req.task}: ${reason}`, req.task);
          await deps.ledger.record({ ...base, ...usage, cacheHit: false, status: "invalid", schemaValid: false, error: reason, latencyMs, attempt });
          if (reasked) throw lastError;
          reasked = true;
          // Echoing a runaway reply invites the model to continue it, so a cut-off reply is not sent back.
          if (cutOff) {
            followUps.push({
              role: "user",
              content:
                "Your previous response was cut off at the token limit before the JSON was complete. Return the complete JSON object again, shorter: no repeated entries and only the essential text in each field.",
            });
            continue;
          }
          followUps.push(
            { role: "assistant", content: content.slice(0, MAX_ECHOED_RESPONSE_CHARS) },
            {
              role: "user",
              content: `Your previous response was rejected by the validator: ${reason}\nReturn the complete corrected JSON object only, matching the schema exactly.`,
            },
          );
          continue;
        }

        await deps.ledger.record({ ...base, ...usage, cacheHit: false, status: "ok", schemaValid: true, latencyMs, attempt });
        if (!req.noCache) await deps.cache.put(key, { model: deps.model, task: req.task, response: json });
        return value;
      }
      throw lastError;
    },
  };
}

export function createLlmClient(opts: LlmClientOptions): LlmPort {
  return createLlmClientFromDeps({
    transport: opts.transport ?? createOpenAiTransport({ baseURL: opts.baseURL, apiKey: opts.apiKey }),
    model: opts.model,
    cache: createSqlLlmCache(opts.sql),
    ledger: createSqlLedger(opts.sql),
    dailyCallBudget: opts.dailyCallBudget,
    structuredOutput: opts.structuredOutput,
  });
}
