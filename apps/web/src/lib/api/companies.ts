import { USE_MOCKS } from "@/lib/env";
import { parseMock, request } from "./http";
import { mocks } from "./mock";
import { CompanySearchResponseSchema, FinancialsResponseSchema, HoldingsResponseSchema } from "./schemas";

export async function getHoldings() {
  if (USE_MOCKS) return parseMock(HoldingsResponseSchema, (await mocks()).holdings(), "holdings");
  return request("/holdings", HoldingsResponseSchema);
}

export async function searchCompanies(q: string, signal?: AbortSignal) {
  if (USE_MOCKS) return parseMock(CompanySearchResponseSchema, (await mocks(false)).search(q), "search");
  return request(`/companies/search?q=${encodeURIComponent(q)}`, CompanySearchResponseSchema, { signal });
}

export async function getFinancials(symbol: string) {
  return request(`/companies/${encodeURIComponent(symbol)}/financials`, FinancialsResponseSchema);
}
