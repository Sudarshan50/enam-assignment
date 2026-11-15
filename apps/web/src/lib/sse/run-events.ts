import { RESEARCH_EVENT_TYPES, ResearchEventSchema, type ResearchEvent } from "@finn/shared";
import { API_BASE, USE_MOCKS } from "@/lib/env";
import { mocks } from "@/lib/api/mock";

export interface RunEventHandlers {
  onEvent: (event: ResearchEvent) => void;
  /** SSE is unavailable or keeps failing; the caller should poll the run instead. */
  onFallback: () => void;
}

const TERMINAL = new Set<ResearchEvent["type"]>(["run.completed", "run.failed"]);
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Streams a research run's events. The browser's EventSource reconnects on its own and sends
 * `Last-Event-ID`, so a dropped connection resumes where it left off; ids are de-duplicated
 * here in case the server replays.
 */
export function subscribeToRunEvents(runId: string, handlers: RunEventHandlers): () => void {
  if (USE_MOCKS) return subscribeMock(runId, handlers);
  if (typeof EventSource === "undefined") {
    handlers.onFallback();
    return () => {};
  }

  let lastId = 0;
  let errors = 0;
  let closed = false;
  const source = new EventSource(`${API_BASE}/research-runs/${encodeURIComponent(runId)}/events`, { withCredentials: true });

  const close = () => {
    closed = true;
    source.close();
  };

  const handle = (message: MessageEvent<string>) => {
    errors = 0;
    let json: unknown;
    try {
      json = JSON.parse(message.data);
    } catch {
      return;
    }
    const parsed = ResearchEventSchema.safeParse(json);
    if (!parsed.success || parsed.data.id <= lastId) return;
    lastId = parsed.data.id;
    handlers.onEvent(parsed.data);
    if (TERMINAL.has(parsed.data.type)) close();
  };

  source.onmessage = handle;
  for (const type of RESEARCH_EVENT_TYPES) source.addEventListener(type, handle as EventListener);
  source.onerror = () => {
    if (closed) return;
    errors += 1;
    if (source.readyState === EventSource.CLOSED || errors >= MAX_CONSECUTIVE_ERRORS) {
      close();
      handlers.onFallback();
    }
  };

  return close;
}

function subscribeMock(runId: string, { onEvent }: RunEventHandlers): () => void {
  let lastId = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const api = await mocks(false);
    for (const event of api.eventsSince(runId, lastId)) {
      const parsed = ResearchEventSchema.parse(event);
      lastId = parsed.id;
      onEvent(parsed);
      if (TERMINAL.has(parsed.type)) stopped = true;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 300);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
