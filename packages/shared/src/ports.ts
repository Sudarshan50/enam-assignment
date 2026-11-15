import type { Card } from "./contracts/cards";
import type { Category } from "./taxonomy";

/**
 * Abstractions that the domain and worker depend on. Concrete implementations live in
 * @finn/ai (LLM, embeddings) and are wired in each app's composition root.
 */

export interface StructuredCompletionRequest<T> {
  /** Stable name used for caching, cost ledger and prompt versioning, e.g. "classify.v1". */
  task: string;
  promptVersion: string;
  system: string;
  user: string;
  /** JSON schema sent to the model as `response_format`. */
  jsonSchema: Record<string, unknown>;
  /** Final validator; the response is rejected (and retried) if this throws. */
  parse: (value: unknown) => T;
  maxTokens?: number;
  temperature?: number;
  /** Ties the call to a research run or announcement in the cost ledger. */
  ref?: { kind: "announcement" | "research_run" | "document" | "ask" | "alert_rule"; id: string };
  /** Skip the response cache (cache is on by default). */
  noCache?: boolean;
}

export interface LlmPort {
  complete<T>(request: StructuredCompletionRequest<T>): Promise<T>;
}

export type EmbeddingTask = "document" | "search_query" | "question_answering" | "clustering";

export interface EmbedDocumentInput {
  text: string;
  /** Used to build the EmbeddingGemma `title: ... | text: ...` prefix. */
  title: string;
}

export interface EmbeddingPort {
  readonly model: string;
  readonly dims: number;
  embedDocuments(inputs: EmbedDocumentInput[]): Promise<number[][]>;
  embedQuery(text: string, task?: Exclude<EmbeddingTask, "document">): Promise<number[]>;
}

export interface ClassificationInput {
  symbol: string;
  companyName: string;
  subject: string;
  text: string;
  exchangeSummary: string | null;
}

export interface ClassificationResult {
  category: Category;
  /** 0.7..1.3, how material this specific filing is relative to its category baseline. */
  impact: number;
  confidence: number;
  oneLiner: string;
  reasonCodes: string[];
}

/** LLM fallback used only when the rule classifier returns `unclassified` or low confidence. */
export interface AnnouncementClassifier {
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}

export interface EnrichmentInput {
  seqId: string;
  symbol: string;
  companyName: string;
  category: Category;
  subject: string;
  text: string;
  exchangeSummary: string | null;
  /** Text of the attached PDF (first pages), already extracted. */
  attachmentText: string | null;
  attachmentUrl: string | null;
  publishedAt: Date;
}

/** Builds the typed card for non-results categories (management change, deal, rating...). */
export interface CardEnricher {
  enrich(input: EnrichmentInput): Promise<Card | null>;
}
