import type { MockApi } from "@/mocks";
import { mockLatency } from "./http";

let loaded: Promise<MockApi> | null = null;

/** Lazily loads the mock layer so it never ships in a live build's main bundle. */
export async function mocks(latency = true): Promise<MockApi> {
  loaded ??= import("@/mocks").then((m) => m.mockApi);
  const api = await loaded;
  if (latency) await mockLatency();
  return api;
}
