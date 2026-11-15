import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listenError: undefined as Error | undefined,
  configError: undefined as Error | undefined,
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), fatal: vi.fn(), error: vi.fn(), warn: vi.fn() }));
const container = vi.hoisted(() => ({ deps: { marker: "deps" }, close: vi.fn(async () => {}) }));

class FakeServer extends EventEmitter {
  keepAliveTimeout = 0;
  headersTimeout = 0;
  close = vi.fn(() => setImmediate(() => this.emit("close")));
  closeIdleConnections = vi.fn();
  closeAllConnections = vi.fn();
}
const servers: FakeServer[] = [];

vi.mock("../src/config", () => ({
  loadConfig: vi.fn(() => {
    if (state.configError) throw state.configError;
    return { LOG_LEVEL: "silent", PORT: 4321, NODE_ENV: "test" };
  }),
}));
vi.mock("../src/lib/logger", () => ({ createLogger: vi.fn(() => logger) }));
vi.mock("../src/container", () => ({ buildContainer: vi.fn(async () => container) }));
vi.mock("../src/app", () => ({
  createApp: vi.fn(() => ({
    listen: (_port: number, cb: (err?: Error) => void) => {
      const server = new FakeServer();
      servers.push(server);
      setImmediate(() => cb(state.listenError));
      return server;
    },
  })),
}));

let handlers: Record<string, () => void>;
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  servers.length = 0;
  state.listenError = undefined;
  state.configError = undefined;
  handlers = {};
  vi.spyOn(process, "once").mockImplementation(((event: string, fn: () => void) => {
    handlers[event] = fn;
    return process;
  }) as never);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  logger.info.mockReset();
  logger.fatal.mockReset();
  container.close.mockClear();
});

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("server entrypoint", () => {
  it("listens on PORT with keep-alive longer than Render's proxy, and shuts down gracefully once on SIGTERM", async () => {
    const { buildContainer } = await import("../src/container");
    await import("../src/server");
    await flush();

    const server = servers[0]!;
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(66_000);
    expect(logger.info).toHaveBeenCalledWith({ port: 4321, env: "test" }, "FINN API listening");
    const signal = vi.mocked(buildContainer).mock.calls[0]![1].shutdownSignal!;
    expect(signal.aborted).toBe(false);
    expect(Object.keys(handlers).sort()).toEqual(["SIGINT", "SIGTERM"]);

    handlers.SIGTERM!();
    handlers.SIGINT!();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(container.close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({ signal: "SIGTERM" }, "shutting down");
    expect(logger.info).toHaveBeenCalledWith("bye");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 1 when the port cannot be bound", async () => {
    state.listenError = new Error("EADDRINUSE");
    await import("../src/server");
    await flush();
    expect(logger.fatal).toHaveBeenCalledWith({ err: state.listenError }, "failed to listen");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("prints only the message and exits 1 on an invalid environment", async () => {
    state.configError = new Error("Invalid API environment:\n  JOBS_SECRET: too short");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../src/server");
    await flush();
    expect(consoleError).toHaveBeenCalledWith("Invalid API environment:\n  JOBS_SECRET: too short");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
