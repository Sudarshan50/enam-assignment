import type { z } from "zod";
import { API_BASE } from "@/lib/env";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  method?: Method;
  body?: unknown;
  signal?: AbortSignal;
}

async function send(path: string, { method = "GET", body, signal }: RequestOptions): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    signal,
    credentials: "same-origin",
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      /* non-JSON error body */
    }
    const serverMessage = payload && typeof payload === "object" && "message" in payload ? (payload as { message: unknown }).message : null;
    const message = typeof serverMessage === "string" && serverMessage ? serverMessage : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return response;
}

/** Fetches a JSON endpoint and validates it against a zod schema. */
export async function request<S extends z.ZodType>(path: string, schema: S, options: RequestOptions = {}): Promise<z.output<S>> {
  const response = await send(path, options);
  const json: unknown = response.status === 204 ? null : await response.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`[finn] ${path} did not match its contract`, parsed.error.issues);
    throw new ApiError(`Unexpected response shape from ${path}`, 502, parsed.error.issues);
  }
  return parsed.data;
}

/** For endpoints whose body we do not need (interactions, deletes). */
export async function requestVoid(path: string, options: RequestOptions = {}): Promise<void> {
  await send(path, options);
}

/** Validates mock data with the same schema the live response would pass. */
export function parseMock<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    console.error(`[finn] mock ${label} violates its contract`, parsed.error.issues);
    throw new Error(`Mock ${label} violates its contract`);
  }
  return parsed.data;
}

export function mockLatency(min = 180, max = 520): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}
