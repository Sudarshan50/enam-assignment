import { AskResponseSchema, ResearchRunSchema } from "@finn/shared";
import { USE_MOCKS } from "@/lib/env";
import { parseMock, request } from "./http";
import { mocks } from "./mock";
import { StartRunResponseSchema, SymbolResearchResponseSchema } from "./schemas";

export async function startResearch(symbol: string) {
  if (USE_MOCKS) return parseMock(StartRunResponseSchema, (await mocks()).startRun(symbol), "startRun");
  return request("/research-runs", StartRunResponseSchema, { method: "POST", body: { symbol } });
}

export async function getRun(runId: string) {
  if (USE_MOCKS) return parseMock(ResearchRunSchema, (await mocks(false)).getRun(runId), "run");
  return request(`/research-runs/${encodeURIComponent(runId)}`, ResearchRunSchema);
}

export async function getResearchForSymbol(symbol: string) {
  if (USE_MOCKS) return parseMock(SymbolResearchResponseSchema, (await mocks()).researchForSymbol(symbol), "research");
  return request(`/companies/${encodeURIComponent(symbol)}/research`, SymbolResearchResponseSchema);
}

export async function ask(symbol: string, question: string) {
  if (USE_MOCKS) {
    const api = await mocks();
    await new Promise((r) => setTimeout(r, 900));
    return parseMock(AskResponseSchema, api.ask(symbol, question), "ask");
  }
  return request("/ask", AskResponseSchema, { method: "POST", body: { symbol, question } });
}
