"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { ResearchEvent, RunStatus } from "@finn/shared";
import { researchApi } from "@/lib/api";
import { subscribeToRunEvents } from "@/lib/sse/run-events";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "partial", "failed", "cancelled"]);
export const isTerminalStatus = (status: RunStatus | undefined) => status !== undefined && TERMINAL.has(status);

export type Transport = "idle" | "sse" | "polling";

/**
 * Finds or starts the research run for a symbol, then follows it live: SSE events drive
 * refetches of the run, and if SSE fails the run is polled every 3 seconds instead.
 */
export function useResearch(symbol: string) {
  const [runId, setRunId] = useState<string | null>(null);
  const [startError, setStartError] = useState<Error | null>(null);
  const [starting, setStarting] = useState(false);
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [transport, setTransport] = useState<Transport>("idle");
  const [cached, setCached] = useState(false);
  const autoStarted = useRef(false);

  const existing = useSWR(["research", symbol], () => researchApi.getResearchForSymbol(symbol), { revalidateOnFocus: false });

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await researchApi.startResearch(symbol);
      setEvents([]);
      setCached(Boolean(res.cached));
      setRunId(res.runId);
    } catch (error) {
      setStartError(error as Error);
    } finally {
      setStarting(false);
    }
  }, [symbol]);

  useEffect(() => {
    if (existing.data === undefined || runId) return;
    if (existing.data.run) {
      setRunId(existing.data.run.id);
      setCached(isTerminalStatus(existing.data.run.status));
    } else if (!autoStarted.current) {
      autoStarted.current = true;
      void start();
    }
  }, [existing.data, runId, start]);

  const run = useSWR(runId ? ["run", runId] : null, () => researchApi.getRun(runId!), {
    fallbackData: existing.data?.run && existing.data.run.id === runId ? existing.data.run : undefined,
    refreshInterval: (latest) => (transport === "polling" && !isTerminalStatus(latest?.status) ? 3000 : 0),
    revalidateOnFocus: false,
  });
  const { mutate: refreshRun } = run;

  useEffect(() => {
    if (!runId) return;
    setTransport("sse");
    let pending: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToRunEvents(runId, {
      onEvent: (event) => {
        setEvents((prev) => (prev.some((e) => e.id === event.id) ? prev : [...prev, event]));
        if (event.type.startsWith("module.") || event.type.startsWith("run.") || event.type === "document.discovered" || event.type === "document.embedded") {
          if (pending) clearTimeout(pending);
          pending = setTimeout(() => void refreshRun(), 120);
        }
        if (event.type === "run.completed" || event.type === "run.failed") setTransport("idle");
      },
      onFallback: () => setTransport("polling"),
    });
    return () => {
      if (pending) clearTimeout(pending);
      unsubscribe();
    };
  }, [runId, refreshRun]);

  return {
    run: run.data ?? null,
    events,
    transport,
    cached,
    starting: starting || (existing.isLoading && !existing.data),
    error: startError ?? existing.error ?? run.error ?? null,
    rebuild: start,
  };
}
