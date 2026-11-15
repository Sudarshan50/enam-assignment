import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { type AskEngine, createAskService } from "../src/services/askService";
import { createInteractionService } from "../src/services/interactionService";
import type { PrefsRepository } from "../src/services/prefsService";
import { auth, buildTestApp } from "./helpers";

function namedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

function askApp(engine: AskEngine, remaining = 10) {
  const ask = createAskService({ engine, companyExists: async (s) => s === "TCS" });
  return buildTestApp({ ask, llmBudget: { remaining: async () => remaining } });
}

describe("POST /api/v1/ask", () => {
  const question = { symbol: "tcs", question: "What did management guide for margins?" };

  it("returns the cited answer", async () => {
    const answer = vi.fn(async () => ({ answer: [{ text: "Margins 26-28%", citations: [], grounded: false }], insufficientSources: false }));
    const res = await request(askApp({ answer })).post("/api/v1/ask").set(auth).send(question);
    expect(res.status).toBe(200);
    expect(res.body.answer[0].text).toBe("Margins 26-28%");
    expect(answer).toHaveBeenCalledWith({ symbol: "TCS", question: question.question });
  });

  it("refuses up front with 429 once the daily LLM budget is spent", async () => {
    const answer = vi.fn();
    const res = await request(askApp({ answer }, 0)).post("/api/v1/ask").set(auth).send(question);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("llm_budget_exhausted");
    expect(answer).not.toHaveBeenCalled();
  });

  it("maps BudgetExceededError to 429 and LlmUnavailableError to 503", async () => {
    const budget = await request(askApp({ answer: async () => Promise.reject(namedError("BudgetExceededError")) }))
      .post("/api/v1/ask")
      .set(auth)
      .send(question);
    expect(budget.status).toBe(429);
    const down = await request(askApp({ answer: async () => Promise.reject(namedError("LlmUnavailableError")) }))
      .post("/api/v1/ask")
      .set(auth)
      .send(question);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("llm_unavailable");
  });

  it("404s for an unknown company", async () => {
    const res = await request(askApp({ answer: vi.fn() })).post("/api/v1/ask").set(auth).send({ ...question, symbol: "NOPE" });
    expect(res.status).toBe(404);
  });

  it("applies the stricter ask rate limit", async () => {
    const ask = createAskService({ engine: { answer: async () => ({ answer: [], insufficientSources: true }) }, companyExists: async () => true });
    const app = buildTestApp({ ask }, { rateLimits: { ...open(), ask: { windowMs: 60_000, limit: 1 } } });
    expect((await request(app).post("/api/v1/ask").set(auth).send(question)).status).toBe(200);
    expect((await request(app).post("/api/v1/ask").set(auth).send(question)).status).toBe(429);
  });
});

function open() {
  const rule = { windowMs: 60_000, limit: 10_000 };
  return { global: rule, ask: rule, research: rule, pushTest: rule };
}

describe("POST /api/v1/interactions", () => {
  function setup(category: string | null | undefined, current: number | null = null) {
    const record = vi.fn(async () => {});
    const weights: Record<string, number> = {};
    const prefs: PrefsRepository = {
      get: vi.fn(),
      update: vi.fn(),
      updateCategoryWeight: vi.fn(async (cat, next) => (weights[cat] = next(current))),
    };
    const interactions = createInteractionService({
      repo: { findCategory: async () => category, record },
      prefs,
      learner: { adjust: (w, action) => (action === "dismiss" ? w - 0.5 : w + 1) },
    });
    return { app: buildTestApp({ interactions }), record, weights };
  }

  it("records the interaction and nudges the category weight, clamped to USER_WEIGHT_RANGE", async () => {
    const { app, record, weights } = setup("dividend", 1.4);
    const res = await request(app).post("/api/v1/interactions").set(auth).send({ seqId: "123", action: "pin" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, category: "dividend", weight: 1.6 });
    expect(record).toHaveBeenCalledWith({ seqId: "123", action: "pin", category: "dividend" });
    expect(weights.dividend).toBe(1.6);
  });

  it("starts unset weights from neutral", async () => {
    const { app } = setup("results");
    const res = await request(app).post("/api/v1/interactions").set(auth).send({ seqId: "1", action: "dismiss" });
    expect(res.body.weight).toBe(0.5);
  });

  it("records but does not learn from unclassified items", async () => {
    const { app, record } = setup("unclassified");
    const res = await request(app).post("/api/v1/interactions").set(auth).send({ seqId: "1", action: "undo_dismiss" });
    expect(res.body).toEqual({ ok: true, category: null, weight: null });
    expect(record).toHaveBeenCalled();
  });

  it("404s for an unknown announcement", async () => {
    const { app, record } = setup(undefined);
    const res = await request(app).post("/api/v1/interactions").set(auth).send({ seqId: "nope", action: "open" });
    expect(res.status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });
});
