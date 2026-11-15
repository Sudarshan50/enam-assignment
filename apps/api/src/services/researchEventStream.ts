import type { Request, Response } from "express";
import type { RunStatus } from "@finn/shared";
import type { Logger } from "../lib/logger";
import { toIsoRequired } from "../lib/time";

export interface ResearchEventRow {
  id: number;
  runId: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ResearchEventsSource {
  listAfter(runId: string, afterId: number, limit: number): Promise<ResearchEventRow[]>;
  /** null when the run does not exist. */
  runStatus(runId: string): Promise<RunStatus | null>;
}

export interface SseOptions {
  pollMs: number;
  heartbeatMs: number;
  /** Streams end after this long; EventSource reconnects with Last-Event-ID. */
  maxDurationMs: number;
  retryMs: number;
}

export const DEFAULT_SSE_OPTIONS: SseOptions = { pollMs: 1500, heartbeatMs: 15_000, maxDurationMs: 5 * 60_000, retryMs: 3000 };

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "partial", "failed", "cancelled"]);

const BATCH = 200;

export function parseLastEventId(header: string | undefined, query: number | undefined): number {
  const fromHeader = header !== undefined && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
  const id = fromHeader ?? query ?? 0;
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export function formatEvent(e: ResearchEventRow): string {
  const payload = { id: e.id, runId: e.runId, type: e.type, message: e.message, data: e.data, createdAt: toIsoRequired(e.createdAt) };
  return `id: ${e.id}\nevent: ${e.type.replace(/[\r\n]/g, "")}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Replays events after `lastEventId`, then polls the table until the run reaches a terminal status,
 * the client disconnects, the server shuts down, or `maxDurationMs` passes.
 */
export function streamResearchEvents(
  req: Request,
  res: Response,
  args: { source: ResearchEventsSource; runId: string; lastEventId: number; options: SseOptions; log: Logger; signal?: AbortSignal },
): Promise<void> {
  const { source, runId, options, log, signal } = args;
  let lastId = args.lastEventId;
  let closed = false;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  const write = (chunk: string) => {
    if (closed || res.writableEnded) return;
    res.write(chunk);
    (res as Response & { flush?: () => void }).flush?.();
  };

  return new Promise<void>((resolve) => {
    let pollTimer: NodeJS.Timeout | undefined;
    const heartbeat = setInterval(() => write(`: ping\n\n`), options.heartbeatMs);
    const maxTimer = setTimeout(() => finish(), options.maxDurationMs);

    function finish() {
      if (closed) return;
      closed = true;
      clearTimeout(pollTimer);
      clearInterval(heartbeat);
      clearTimeout(maxTimer);
      signal?.removeEventListener("abort", finish);
      if (!res.writableEnded) res.end();
      resolve();
    }

    async function drain() {
      for (;;) {
        const events = await source.listAfter(runId, lastId, BATCH);
        for (const e of events) {
          write(formatEvent(e));
          lastId = e.id;
        }
        if (events.length < BATCH || closed) return;
      }
    }

    async function pump() {
      if (closed) return;
      try {
        await drain();
        const status = await source.runStatus(runId);
        if (status === null || TERMINAL_STATUSES.has(status)) {
          await drain();
          write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
          return finish();
        }
      } catch (err) {
        log.warn({ err, runId }, "research event poll failed");
        write(`event: warning\ndata: ${JSON.stringify({ message: "Progress updates are delayed; retrying." })}\n\n`);
      }
      if (!closed) pollTimer = setTimeout(pump, options.pollMs);
    }

    res.on("close", finish);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) return finish();
    write(`retry: ${options.retryMs}\n\n`);
    void pump();
  });
}
