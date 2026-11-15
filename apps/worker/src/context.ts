import type { Sql } from "@finn/db";
import type { AnnouncementClassifier, CardEnricher, EmbeddingPort, LlmPort } from "@finn/shared/ports";
import type { HttpClient } from "@finn/sources/http/client";

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
}

/** Everything a pipeline needs, built once in the composition root (container.ts). */
export interface WorkerContext {
  sql: Sql;
  http: HttpClient;
  llm: LlmPort;
  embeddings: EmbeddingPort;
  classifier: AnnouncementClassifier;
  enricher: CardEnricher;
  log: Logger;
  env: NodeJS.ProcessEnv;
}

export type CommandArgs = { _: string[] } & Record<string, string | boolean | string[] | undefined>;

export interface Command {
  name: string;
  description: string;
  run(ctx: WorkerContext, args: CommandArgs): Promise<void>;
}
