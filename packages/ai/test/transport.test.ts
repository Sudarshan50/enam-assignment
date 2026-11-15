import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmTransportError } from "../src/llm/errors";
import { createOpenAiTransport, UnsupportedResponseFormatError } from "../src/llm/transport";

type Handler = (body: Record<string, unknown>, res: ServerResponse) => void;

let server: Server;
let baseURL: string;
let handler: Handler = () => {};
const received: Record<string, unknown>[] = [];

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data || "{}") as Record<string, unknown>;
      received.push({ path: req.url, auth: req.headers.authorization, ...body });
      handler(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const completion = (content: string | null, usage = true) => ({
  id: "x",
  object: "chat.completion",
  created: 0,
  model: "glm-test",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: content ? "stop" : "length" }],
  ...(usage ? { usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } } : {}),
});

describe("OpenAI-compatible transport", () => {
  it("posts the chat request and maps content, usage and finish reason", async () => {
    handler = (_b, res) => json(res, 200, completion('{"ok":true}'));
    const t = createOpenAiTransport({ baseURL, apiKey: "test-key" });
    const out = await t.chat({
      model: "glm-test",
      messages: [{ role: "user", content: "hi" }],
      responseFormat: { type: "json_object" },
      maxTokens: 50,
      temperature: 0,
    });
    expect(out).toEqual({ content: '{"ok":true}', promptTokens: 11, completionTokens: 3, finishReason: "stop" });
    expect(received.at(-1)).toMatchObject({
      path: "/v1/chat/completions",
      auth: "Bearer test-key",
      model: "glm-test",
      response_format: { type: "json_object" },
      max_tokens: 50,
      temperature: 0,
    });
  });

  it("reports missing usage as null tokens", async () => {
    handler = (_b, res) => json(res, 200, completion("{}", false));
    const out = await createOpenAiTransport({ baseURL, apiKey: "k" }).chat({ model: "m", messages: [], responseFormat: { type: "json_object" } });
    expect(out).toMatchObject({ promptTokens: null, completionTokens: null });
  });

  it("treats an empty completion as a transport error naming the finish reason", async () => {
    handler = (_b, res) => json(res, 200, completion(null));
    const err = await createOpenAiTransport({ baseURL, apiKey: "k" })
      .chat({ model: "m", messages: [], responseFormat: { type: "json_object" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect((err as Error).message).toMatch(/finish_reason=length/);
  });

  it("maps a 400 about response_format to UnsupportedResponseFormatError", async () => {
    handler = (_b, res) => json(res, 400, { error: { message: "response_format json_schema is not supported", type: "invalid_request_error" } });
    const err = await createOpenAiTransport({ baseURL, apiKey: "k" })
      .chat({ model: "m", messages: [], responseFormat: { type: "json_schema", json_schema: { name: "x", strict: true, schema: {} } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedResponseFormatError);
  });

  it("maps HTTP errors to LlmTransportError with the status", async () => {
    handler = (_b, res) => json(res, 503, { error: { message: "overloaded" } });
    const err = await createOpenAiTransport({ baseURL, apiKey: "k" })
      .chat({ model: "m", messages: [], responseFormat: { type: "json_object" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect((err as LlmTransportError).status).toBe(503);
  });

  it("maps connection failures to LlmTransportError without a status", async () => {
    const t = createOpenAiTransport({ baseURL: "http://127.0.0.1:9/v1", apiKey: "k", timeoutMs: 2_000 });
    const err = await t.chat({ model: "m", messages: [], responseFormat: { type: "json_object" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect((err as LlmTransportError).status).toBeNull();
  });
});
