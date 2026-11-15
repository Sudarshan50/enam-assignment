import { describe, expect, it, vi } from "vitest";
import type { Sql } from "@finn/db";
import { loadAskEngine, loadRuleParser, loadWeightLearner } from "../src/adapters/agentModules";
import { loadConfig } from "../src/config";
import { JOBS_SECRET, TOKEN } from "./helpers";

// Each agent module fails to load, as on a server where a workspace package is missing or broken.
vi.mock("@finn/domain/alerts/parseRuleText", () => {
  throw Object.assign(new Error("Cannot find package '@finn/domain'"), { code: "ERR_MODULE_NOT_FOUND" });
});
vi.mock("@finn/domain/weights/learn", () => {
  throw new SyntaxError("Unexpected token in learn.ts");
});
vi.mock("@finn/ai/llm/client", () => {
  throw new Error("openai failed to load");
});

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe("agent modules that fail to load degrade the feature instead of crashing the API", () => {
  it("rule previews cannot parse text", async () => {
    const logger = log();
    const parser = await loadRuleParser(logger);
    expect(parser.parse("TCS falls 4%", { isKnownSymbol: () => true })).toBeNull();
    expect(parser.explain({ type: "category", scope: { kind: "portfolio" }, categories: ["results"] })).toBe("");
    const calls = [...logger.warn.mock.calls, ...logger.error.mock.calls];
    expect(calls).toContainEqual([expect.objectContaining({ module: "@finn/domain/alerts/parseRuleText" }), expect.stringContaining("cannot parse text")]);
  });

  it("interactions keep weights unchanged and log an error", async () => {
    const logger = log();
    const learner = await loadWeightLearner(logger);
    expect(learner.adjust(1.2, "pin")).toBe(1.2);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ module: "@finn/domain/weights/learn" }), expect.stringContaining("weights stay unchanged"));
  });

  it("Ask answers 503 ask_unavailable even with credentials", async () => {
    const logger = log();
    const config = loadConfig({
      DATABASE_URL: "postgres://x",
      DEMO_ACCESS_TOKEN: TOKEN,
      JOBS_SECRET,
      LLM_API_KEY: "sk",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_API_TOKEN: "t",
    });
    const engine = await loadAskEngine(config, {} as Sql, logger);
    await expect(engine.answer({ symbol: "TCS", question: "Why?" })).rejects.toMatchObject({
      status: 503,
      code: "ask_unavailable",
      message: expect.stringContaining("not installed"),
    });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ module: expect.stringContaining("@finn/ai") }), expect.stringContaining("Ask disabled"));
  });
});
