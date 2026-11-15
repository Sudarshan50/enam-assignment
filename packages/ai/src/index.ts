export { createLlmClient, createLlmClientFromDeps, istMidnight, type LlmClientDeps, type LlmClientOptions } from "./llm/client";
export { BudgetExceededError, LlmTransportError, LlmUnavailableError, LlmValidationError } from "./llm/errors";
export { CircuitBreaker } from "./llm/circuitBreaker";
export { createOpenAiTransport, type ChatTransport, type ChatRequest, type ChatResponse } from "./llm/transport";
export { createSqlLlmCache, createMemoryLlmCache, llmCacheKey, type LlmCache } from "./llm/cache";
export { createSqlLedger, createMemoryLedger, type LlmLedger } from "./llm/ledger";

export { createEmbeddingClient, EmbeddingError, type EmbeddingClientOptions } from "./embeddings/cloudflare";
export { documentPrompt, queryPrompt } from "./embeddings/prefix";

export { chunkPages, stripBoilerplate, looksLikeHeading, estimateTokens, type TextChunk, type PageText, type ChunkOptions } from "./chunking/chunker";

export { retrieve, retrieveMulti, isWeakRetrieval, type RetrievedChunk, type RetrieveRequest } from "./retrieval/hybrid";
export { rrfFuse, type FusedItem } from "./retrieval/rrf";

export { validateClaims, checkClaim, quoteInText, normaliseForMatch, type RawClaim, type SourceChunk, type ClaimRegenerator } from "./citations/validator";
export { extractNumbers, numberSupported } from "./citations/numbers";
export { groundClaims } from "./citations/ground";

export { extractGuidance, type TranscriptForExtraction } from "./ledger/extract";
export { matchGuidance, summariseLedger, ledgerSummaryText, judge, type LedgerItem, type LedgerEntry, type LedgerSummary } from "./ledger/match";
export { createHistoryActuals, type ActualsResolver, type ActualLookup } from "./ledger/actuals";
export { parseFiscalLabel, quarterDiscussedOn, fiscalYearOf, type FiscalPeriod } from "./ledger/periods";

export { tablesFromRows, HISTORY_SOURCE_LABEL, type HistoryTable, type HistoryTables } from "./financials/history";

export { ModuleRegistry, createDefaultModuleRegistry, moduleCacheKey } from "./modules/registry";
export type { ModuleContext, ModuleDocument, ResearchModuleRunner, ResearchModulePayload } from "./modules/types";

export { answerQuestion, type AskResponse, type AnswerDeps } from "./ask/answer";

export { createLlmClassifier } from "./enrichment/classifier";
export { createCardEnricher } from "./enrichment/cardEnricher";
