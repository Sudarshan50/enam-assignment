import type { GuidanceItemInput } from "@finn/db/repositories/guidance";
import type { LlmPort } from "@finn/shared/ports";
import { quoteInText, type SourceChunk } from "../citations/validator";
import * as prompt from "../prompts/guidance";
import { buildSourcesBlock } from "../prompts/sources";
import { toStrictJsonSchema } from "../util/schema";
import { parseFiscalLabel } from "./periods";

export interface TranscriptForExtraction {
  documentId: string;
  symbol: string;
  companyName: string;
  /** e.g. "Q2 FY27 concall". */
  label: string;
  /** ISO date of the call (month precision is enough). */
  callDate: string;
  chunks: (SourceChunk & { section?: string | null })[];
}

export interface ExtractionStats {
  proposed: number;
  kept: number;
  rejected: { reason: string; quote: string }[];
}

/** Chunks per LLM call; a typical transcript (20-30 chunks) goes in one call. */
const CHUNKS_PER_CALL = 45;

function encodeBounds(bound: "point" | "range" | "at_least" | "at_most", low: number | null, high: number | null): { low: number | null; high: number | null } | null {
  switch (bound) {
    case "point": {
      const v = low ?? high;
      return v === null ? null : { low: v, high: v };
    }
    case "range":
      if (low === null || high === null) return null;
      return low === high ? { low, high } : { low: Math.min(low, high), high: Math.max(low, high) };
    case "at_least":
      return low === null ? null : { low, high: null };
    case "at_most":
      return high === null ? (low === null ? null : { low: null, high: low }) : { low: null, high };
  }
}

/**
 * Extracts guidance from one transcript into the closed metric taxonomy. Items whose quote is not verbatim in
 * the cited chunk, whose horizon is unparseable, or whose horizon ended before the call are rejected.
 */
export async function extractGuidance(deps: { llm: LlmPort }, t: TranscriptForExtraction): Promise<{ items: GuidanceItemInput[]; stats: ExtractionStats }> {
  const stats: ExtractionStats = { proposed: 0, kept: 0, rejected: [] };
  const items: GuidanceItemInput[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < t.chunks.length; i += CHUNKS_PER_CALL) {
    const batch = t.chunks.slice(i, i + CHUNKS_PER_CALL);
    const sources = buildSourcesBlock(batch);
    const res = await deps.llm.complete({
      task: prompt.TASK,
      promptVersion: prompt.PROMPT_VERSION,
      system: prompt.SYSTEM,
      user: prompt.buildUser(t.companyName, t.symbol, t.label, t.callDate, sources.block),
      jsonSchema: toStrictJsonSchema(prompt.GuidanceExtractionSchema),
      parse: (v) => prompt.GuidanceExtractionSchema.parse(v),
      ref: { kind: "document", id: t.documentId },
      maxTokens: 6_000,
    });

    const byId = new Map(batch.map((c) => [c.chunkId, c] as const));
    for (const raw of res.items) {
      stats.proposed++;
      const chunk = byId.get(sources.resolve(raw.sourceId));
      if (!chunk) {
        stats.rejected.push({ reason: `unknown source ${raw.sourceId}`, quote: raw.quote });
        continue;
      }
      if (!quoteInText(raw.quote, chunk.text)) {
        stats.rejected.push({ reason: "quote not verbatim in source", quote: raw.quote });
        continue;
      }
      const period = parseFiscalLabel(raw.horizon);
      if (!period) {
        stats.rejected.push({ reason: `unrecognised horizon ${raw.horizon}`, quote: raw.quote });
        continue;
      }
      if (period.end < t.callDate.slice(0, 10) && !raw.withdrawn) {
        stats.rejected.push({ reason: `horizon ${period.label} ended before the call`, quote: raw.quote });
        continue;
      }
      const bounds = encodeBounds(raw.bound, raw.low, raw.high);
      if (!bounds) {
        stats.rejected.push({ reason: "no numeric value", quote: raw.quote });
        continue;
      }
      const key = [raw.metric, period.label, raw.quote.trim()].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const page = chunk.pages?.find((p) => quoteInText(raw.quote, p.text))?.page ?? chunk.pageStart;
      items.push({
        symbol: t.symbol,
        documentId: t.documentId,
        chunkId: chunk.chunkId,
        page,
        metric: raw.metric,
        statementType: raw.statementType,
        low: bounds.low,
        high: bounds.high,
        unit: raw.unit,
        horizonLabel: period.label,
        horizonStart: period.start,
        horizonEnd: period.end,
        scope: raw.scope,
        segment: raw.scope === "segment" ? raw.segment : null,
        speaker: raw.speaker,
        quote: raw.quote.trim(),
        saidIn: t.label,
        saidOn: t.callDate.slice(0, 10),
        withdrawn: raw.withdrawn,
        extractorVersion: prompt.EXTRACTOR_VERSION,
      });
      stats.kept++;
    }
  }
  return { items, stats };
}
