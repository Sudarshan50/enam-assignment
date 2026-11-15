"use client";

import useSWR from "swr";
import { alertsApi, companiesApi, digestApi, systemApi, type DigestWindow } from "@/lib/api";

export function useDigest(window: DigestWindow) {
  return useSWR(["digest", window], () => digestApi.getDigest(window), { keepPreviousData: true, refreshInterval: 5 * 60_000 });
}

export function useHoldings() {
  return useSWR("holdings", () => companiesApi.getHoldings());
}

export function useAlerts() {
  return useSWR("alerts", () => alertsApi.getAlerts(), { refreshInterval: 60_000 });
}

export function useAlertRules() {
  return useSWR("alert-rules", () => alertsApi.getRules());
}

export function useEngine() {
  return useSWR("engine", () => systemApi.getEngine(), { refreshInterval: 30_000 });
}

export function useCompanySearch(query: string) {
  const q = query.trim();
  return useSWR(q.length >= 1 ? ["search", q.toUpperCase()] : null, () => companiesApi.searchCompanies(q), { keepPreviousData: true });
}
