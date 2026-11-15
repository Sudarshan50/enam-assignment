import type { Sql } from "@finn/db";
import { llmRepo } from "@finn/db/repositories/llm";
import { hashParts } from "../util/hash";

export interface LlmCache {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, entry: { model: string; task: string; response: unknown }): Promise<void>;
}

export function llmCacheKey(parts: {
  model: string;
  task: string;
  promptVersion: string;
  jsonSchema: Record<string, unknown>;
  system: string;
  user: string;
  /** Output mode changes model behaviour, so answers from different modes are cached apart. */
  format?: string;
}): string {
  return hashParts(parts.model, parts.task, parts.promptVersion, hashParts(parts.jsonSchema), parts.system, parts.user, parts.format ?? "");
}

export function createSqlLlmCache(sql: Sql): LlmCache {
  const repo = llmRepo(sql);
  return {
    get: (key) => repo.cacheGet(key),
    put: (key, e) => repo.cachePut(key, e.model, e.task, e.response),
  };
}

export function createMemoryLlmCache(): LlmCache & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    async get(key) {
      return entries.get(key);
    },
    async put(key, e) {
      entries.set(key, e.response);
    },
  };
}
