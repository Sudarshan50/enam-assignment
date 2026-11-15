import OpenAI from "openai";
import { LlmTransportError } from "./errors";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ResponseFormat =
  | { type: "json_schema"; json_schema: { name: string; strict: true; schema: Record<string, unknown> } }
  | { type: "json_object" };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  responseFormat: ResponseFormat;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** The only thing the client needs from a provider; tests inject a fake. */
export interface ChatTransport {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/** Thrown when the provider rejects `response_format: json_schema`, so the client can fall back to json_object. */
export class UnsupportedResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedResponseFormatError";
  }
}

export function createOpenAiTransport(opts: { baseURL: string; apiKey: string; timeoutMs?: number }): ChatTransport {
  const client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 0 });
  return {
    async chat(req) {
      try {
        const res = await client.chat.completions.create({
          model: req.model,
          messages: req.messages,
          response_format: req.responseFormat,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
        });
        const choice = res.choices[0];
        const message = choice?.message as { content?: string | null } | undefined;
        if (!message?.content) throw new LlmTransportError(`Empty completion (finish_reason=${choice?.finish_reason ?? "none"})`);
        return {
          content: message.content,
          promptTokens: res.usage?.prompt_tokens ?? null,
          completionTokens: res.usage?.completion_tokens ?? null,
        };
      } catch (err) {
        if (err instanceof LlmTransportError) throw err;
        if (err instanceof OpenAI.APIError) {
          const status = typeof err.status === "number" ? err.status : null;
          if (status === 400 && /response_format|json_schema/i.test(err.message)) throw new UnsupportedResponseFormatError(err.message);
          throw new LlmTransportError(`LLM HTTP ${status ?? "?"}: ${err.message.slice(0, 200)}`, status);
        }
        throw new LlmTransportError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
