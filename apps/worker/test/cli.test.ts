import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, CommandArgs } from "../src/context";
import { recordingLogger } from "./support/fakes";

const h = vi.hoisted(() => ({
  research: async (): Promise<{ commands: readonly Command[]; error: Error | null }> => ({ commands: [], error: null }),
  commands: [] as Command[],
  ctxEnv: [] as unknown[],
  log: null as unknown as ReturnType<typeof import("./support/fakes").recordingLogger>,
  crashLog: [] as unknown[],
  closeDb: vi.fn(async () => {}),
}));

vi.mock("../src/commands", async (orig) => {
  const real = await orig<typeof import("../src/commands")>();
  return {
    usage: real.usage,
    loadResearchCommands: () => h.research(),
    buildRegistry: (extra: readonly Command[] = []) => new Map([...h.commands, ...extra].map((c) => [c.name, c])),
  };
});
vi.mock("../src/container", () => ({
  createWorkerContext: (env: unknown) => {
    h.ctxEnv.push(env);
    return { log: h.log, env };
  },
  createLogger: () => ({ error: (...args: unknown[]) => h.crashLog.push(args) }),
}));
vi.mock("@finn/db", () => ({ closeDb: h.closeDb }));

const seen: CommandArgs[] = [];
const command = (name: string, run: (args: CommandArgs) => Promise<void> | void): Command => ({
  name,
  description: `${name} description`,
  async run(_ctx, args) {
    seen.push(args);
    await run(args);
  },
});

const exit = vi.spyOn(process, "exit");
const out = vi.spyOn(console, "log").mockImplementation(() => {});
const err = vi.spyOn(console, "error").mockImplementation(() => {});
const argv = process.argv;

/** Imports cli.ts fresh (it runs main on import) and resolves with the exit code it passes to process.exit. */
async function runCli(...args: string[]): Promise<number> {
  vi.resetModules();
  process.argv = ["node", "cli.ts", ...args];
  const code = new Promise<number>((resolve) => {
    exit.mockImplementationOnce(((c?: number) => resolve(c ?? 0)) as never);
  });
  await import("../src/cli");
  return code;
}

beforeEach(() => {
  seen.length = 0;
  h.ctxEnv.length = 0;
  h.crashLog.length = 0;
  h.log = recordingLogger();
  h.research = async () => ({ commands: [], error: null });
  h.commands = [
    command("ok", () => {}),
    // cli.ts is re-imported per run, so throw the UsageError class from that fresh module graph.
    command("bad-usage", async () => {
      const { UsageError } = await import("../src/args");
      throw new UsageError("--symbol is required");
    }),
    command("boom", () => {
      throw new Error("pipeline exploded");
    }),
    command("throws-string", () => {
      throw "plain string";
    }),
  ];
  out.mockClear();
  err.mockClear();
  h.closeDb.mockClear();
});
afterEach(() => {
  process.argv = argv;
});
afterAll(() => {
  exit.mockRestore();
  out.mockRestore();
  err.mockRestore();
});

const printed = (spy: typeof out) => spy.mock.calls.map((c) => c.join(" ")).join("\n");

describe("worker CLI", () => {
  it("no command prints usage and exits 1; the DB is always closed", async () => {
    expect(await runCli()).toBe(1);
    expect(printed(out)).toMatch(/^Usage: npm run worker -- <command>/);
    expect(printed(out)).toContain("  ok             ok description");
    expect(h.ctxEnv).toEqual([]);
    expect(h.closeDb).toHaveBeenCalledTimes(1);
  });

  it("help and --help print usage and exit 0", async () => {
    expect(await runCli("help")).toBe(0);
    expect(await runCli("ok", "--help")).toBe(0);
    expect(seen).toEqual([]);
    expect(printed(out)).not.toContain("research commands unavailable");
  });

  it("help mentions research commands that failed to load", async () => {
    h.research = async () => ({ commands: [], error: new Error("missing module") });
    expect(await runCli("help")).toBe(0);
    expect(printed(out)).toContain("(research commands unavailable: missing module)");
  });

  it("an unknown command exits 2 with usage on stderr", async () => {
    expect(await runCli("nope", "--x", "1")).toBe(2);
    expect(printed(err)).toMatch(/^Unknown command "nope"\n\nUsage:/);
    expect(h.ctxEnv).toEqual([]);
  });

  it("a research command whose module failed to load exits 1 with the load error", async () => {
    const loadError = new Error("cannot import research");
    h.research = async () => ({ commands: [], error: loadError });
    expect(await runCli("research-run", "--symbol", "TCS")).toBe(1);
    expect(printed(err)).toContain("Research commands failed to load: Error: cannot import research");
    // A non-research unknown command still gets the generic message and exit 2.
    expect(await runCli("other")).toBe(2);
  });

  it("loaded research commands are dispatched like core ones", async () => {
    h.research = async () => ({ commands: [command("research", () => {})], error: null });
    expect(await runCli("research", "--symbol", "TCS")).toBe(0);
    expect(seen).toEqual([{ _: [], symbol: "TCS" }]);
  });

  it("success exits 0 with parsed args, process.env context and a completion log", async () => {
    expect(await runCli("ok", "pos", "--days", "3", "--no-push")).toBe(0);
    expect(seen).toEqual([{ _: ["pos"], days: "3", push: false }]);
    expect(h.ctxEnv).toEqual([process.env]);
    const done = h.log.entries.find((e) => e.msg === "Command completed");
    expect(done?.obj).toMatchObject({ command: "ok", ms: expect.any(Number) });
  });

  it("a UsageError exits 2 naming the command", async () => {
    expect(await runCli("bad-usage")).toBe(2);
    expect(printed(err)).toBe("bad-usage: --symbol is required");
    expect(h.log.messages("error")).toEqual([]);
  });

  it("any other error exits 1 and logs the stack", async () => {
    expect(await runCli("boom")).toBe(1);
    const failed = h.log.entries.find((e) => e.msg === "Command failed");
    expect(failed?.obj).toMatchObject({ command: "boom", error: expect.stringContaining("Error: pipeline exploded") });
    expect(await runCli("throws-string")).toBe(1);
    expect(h.log.entries.at(-1)?.obj).toMatchObject({ command: "throws-string", error: "plain string" });
  });

  it("a crash before dispatch is logged and exits 1, even if closing the DB fails", async () => {
    h.research = async () => {
      throw new Error("registry exploded");
    };
    h.closeDb.mockRejectedValueOnce(new Error("close failed"));
    expect(await runCli("ok")).toBe(1);
    expect(h.crashLog).toEqual([[{ error: expect.stringContaining("registry exploded") }, "Worker crashed"]]);
    expect(h.closeDb).toHaveBeenCalledTimes(1);

    h.commands = [...h.commands, command("ok", () => {})];
    h.research = async () => {
      throw "not an error";
    };
    expect(await runCli("ok")).toBe(1);
    expect(h.crashLog.at(-1)).toEqual([{ error: "not an error" }, "Worker crashed"]);
  });
});
