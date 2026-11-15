import type { Sql } from "@finn/db";
import type { DocType } from "@finn/db/repositories/documents";
import type { ModuleKey } from "@finn/shared/contracts/research";
import type { EmbeddingPort, LlmPort } from "@finn/shared/ports";
import type { HistoryTables } from "../financials/history";

export interface ModuleDocument {
  id: string;
  docType: DocType;
  label: string;
  periodLabel: string;
  periodEnd: string | null;
  url: string;
  sha256: string | null;
  pages: number | null;
}

export interface ModuleContext {
  symbol: string;
  companyName: string;
  runId: string | null;
  sql: Sql;
  llm: LlmPort;
  embeddings: EmbeddingPort;
  /** Documents in `ready` state for the symbol. */
  documents: ModuleDocument[];
  /** Screener history tables (secondary source). */
  history: HistoryTables;
  asOf: Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export type ResearchModulePayload =
  | { status: "done"; payload: unknown }
  | { status: "insufficient_sources"; payload: null; reason: string };

/** One research module. New modules implement this and are added to the registry; nothing else changes. */
export interface ResearchModuleRunner {
  key: ModuleKey;
  /** Bump when the module's logic or prompt changes, to invalidate cached payloads. */
  version: string;
  inputs: { documents: boolean; history: boolean; /** Verdicts depend on today's date. */ asOfDay?: boolean };
  run(ctx: ModuleContext): Promise<ResearchModulePayload>;
}

export function insufficient(reason: string): ResearchModulePayload {
  return { status: "insufficient_sources", payload: null, reason };
}
