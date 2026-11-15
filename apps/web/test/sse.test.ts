import type { ResearchEvent } from "@finn/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventGate, isTerminalEvent, subscribeToRunEvents } from "@/lib/sse/run-events";

const RUN = "90ab5ae8-5968-43c8-80d4-6a52c8000001";

function event(id: number, type: ResearchEvent["type"] = "document.extracted"): ResearchEvent {
  return { id, runId: RUN, type, message: `event ${id}`, data: null, createdAt: "2026-11-15T08:24:06.666Z" };
}
const wire = (e: unknown) => JSON.stringify(e);

describe("createEventGate", () => {
  it("accepts events in order and tracks the last id", () => {
    const gate = createEventGate();
    expect(gate.accept(wire(event(1, "run.queued")))?.type).toBe("run.queued");
    expect(gate.accept(wire(event(2)))?.id).toBe(2);
    expect(gate.lastId).toBe(2);
  });

  it("drops duplicates and replays at or below the last id", () => {
    const gate = createEventGate();
    gate.accept(wire(event(1)));
    gate.accept(wire(event(5)));
    expect(gate.accept(wire(event(5)))).toBeNull();
    expect(gate.accept(wire(event(3)))).toBeNull();
    expect(gate.accept(wire(event(6)))?.id).toBe(6);
  });

  it("resumes after a given id (Last-Event-ID semantics)", () => {
    const gate = createEventGate(10);
    expect(gate.accept(wire(event(10)))).toBeNull();
    expect(gate.accept(wire(event(11)))?.id).toBe(11);
  });

  it("drops malformed and off-contract payloads without advancing", () => {
    const gate = createEventGate();
    expect(gate.accept("not json")).toBeNull();
    expect(gate.accept(wire({ ...event(1), type: "run.exploded" }))).toBeNull();
    expect(gate.accept(wire({ ...event(2), id: "2" }))).toBeNull();
    expect(gate.accept(wire({ status: "completed" }))).toBeNull();
    expect(gate.lastId).toBe(0);
  });

  it("flags run.completed and run.failed as terminal only", () => {
    expect(isTerminalEvent(event(1, "run.completed"))).toBe(true);
    expect(isTerminalEvent(event(1, "run.failed"))).toBe(true);
    expect(isTerminalEvent(event(1, "module.failed"))).toBe(false);
  });
});

/** Minimal EventSource stand-in: records listeners so tests can push frames. */
class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: string) {
    const message = { data } as MessageEvent<string>;
    if (type === "message") this.onmessage?.(message);
    for (const fn of this.listeners.get(type) ?? []) fn(message);
  }
}

describe("subscribeToRunEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("opens the events stream with credentials and de-duplicates replays", () => {
    const seen: number[] = [];
    subscribeToRunEvents(RUN, { onEvent: (e) => seen.push(e.id), onFallback: () => {} });
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`/api/v1/research-runs/${RUN}/events`);
    expect(source.init).toEqual({ withCredentials: true });

    source.emit("run.started", wire(event(1, "run.started")));
    source.emit("document.extracted", wire(event(2)));
    // Browser reconnect replays from the server's point of view; ids already seen are ignored.
    source.emit("run.started", wire(event(1, "run.started")));
    source.emit("document.extracted", wire(event(2)));
    source.emit("module.completed", wire(event(3, "module.completed")));
    expect(seen).toEqual([1, 2, 3]);
  });

  it("closes on a terminal event", () => {
    const onFallback = vi.fn();
    subscribeToRunEvents(RUN, { onEvent: () => {}, onFallback });
    const source = FakeEventSource.instances[0]!;
    source.emit("run.completed", wire(event(9, "run.completed")));
    expect(source.closed).toBe(true);
    source.onerror?.();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("closes and reports onEnd when the server sends `event: end`", () => {
    const onEnd = vi.fn();
    subscribeToRunEvents(RUN, { onEvent: () => {}, onFallback: () => {}, onEnd });
    const source = FakeEventSource.instances[0]!;
    source.emit("end", wire({ status: "partial" }));
    expect(source.closed).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("falls back to polling after repeated errors, and resets the count on a good event", () => {
    const onFallback = vi.fn();
    subscribeToRunEvents(RUN, { onEvent: () => {}, onFallback });
    const source = FakeEventSource.instances[0]!;
    source.onerror?.();
    source.onerror?.();
    source.emit("document.extracted", wire(event(1)));
    source.onerror?.();
    source.onerror?.();
    expect(onFallback).not.toHaveBeenCalled();
    source.onerror?.();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });

  it("falls back immediately when the browser closes the stream", () => {
    const onFallback = vi.fn();
    subscribeToRunEvents(RUN, { onEvent: () => {}, onFallback });
    const source = FakeEventSource.instances[0]!;
    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.();
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("falls back when EventSource is unavailable", () => {
    vi.stubGlobal("EventSource", undefined);
    const onFallback = vi.fn();
    subscribeToRunEvents(RUN, { onEvent: () => {}, onFallback });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});
