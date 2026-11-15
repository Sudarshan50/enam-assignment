import { describe, expect, it, vi } from "vitest";
import { buildRegistry, loadResearchCommands } from "../src/commands";

vi.mock("../src/pipelines/research", () => {
  throw "research module is broken";
});

describe("loadResearchCommands when the research module cannot load", () => {
  it("returns no commands and the load error, leaving core commands usable", async () => {
    const { commands, error } = await loadResearchCommands();
    expect(commands).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message.length).toBeGreaterThan(0);
    expect(buildRegistry(commands).has("ingest")).toBe(true);
  });
});
