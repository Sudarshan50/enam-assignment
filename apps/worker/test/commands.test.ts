import { describe, expect, it } from "vitest";
import { buildRegistry, coreCommands, loadResearchCommands, usage } from "../src/commands";
import type { Command } from "../src/context";

const cmd = (name: string, description = `${name} does things`): Command => ({ name, description, run: async () => {} });

describe("command registry", () => {
  it("registers every core command once, in order", () => {
    const names = [...buildRegistry().keys()];
    expect(names).toEqual(["ingest", "results", "results-backfill", "eod", "backfill-prices", "alerts", "master-list"]);
    expect(names).toEqual(coreCommands.map((c) => c.name));
    for (const c of coreCommands) expect(c.description.length).toBeGreaterThan(0);
  });

  it("appends extra commands and rejects duplicates (including clashes with core names)", () => {
    expect([...buildRegistry([cmd("research")]).keys()].at(-1)).toBe("research");
    expect(() => buildRegistry([cmd("ingest")])).toThrow("Duplicate worker command: ingest");
    expect(() => buildRegistry([cmd("x"), cmd("x")])).toThrow("Duplicate worker command: x");
  });

  it("usage aligns descriptions to the longest name", () => {
    const text = usage(new Map([cmd("a", "first"), cmd("longer-name", "second")].map((c) => [c.name, c])));
    expect(text).toBe(
      ["Usage: npm run worker -- <command> [--key value] [--flag]", "", "Commands:", "  a            first", "  longer-name  second"].join("\n"),
    );
  });

  it("loads the research commands lazily and they don't clash with core commands", async () => {
    const { commands, error } = await loadResearchCommands();
    expect(error).toBeNull();
    expect(commands.length).toBeGreaterThan(0);
    expect(() => buildRegistry(commands)).not.toThrow();
  });
});
