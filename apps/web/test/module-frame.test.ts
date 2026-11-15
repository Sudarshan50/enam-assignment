import type { ResearchModule } from "@finn/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModuleFrame, retryNote } from "@/components/research/module-frame";

const NOW = new Date("2026-11-15T06:00:00Z"); // 11:30 IST

describe("retryNote", () => {
  it("gives the next try in India time, with the date once it is not today", () => {
    expect(retryNote({ status: "pending", attempts: 1, nextAttemptAt: "2026-11-15T06:15:00Z" }, NOW)).toBe("FINN retries it automatically; next try around 11:45 IST.");
    expect(retryNote({ status: "pending", attempts: 1, nextAttemptAt: "2026-11-15T18:35:00Z" }, NOW)).toBe(
      "FINN retries it automatically; next try around 16 Nov, 00:05 IST.",
    );
  });

  it("says a due retry is under way and a dead one has given up", () => {
    expect(retryNote({ status: "pending", attempts: 2, nextAttemptAt: "2026-11-15T05:59:00Z" }, NOW)).toBe("FINN is retrying it now.");
    expect(retryNote({ status: "dead", attempts: 1, nextAttemptAt: null }, NOW)).toBe("FINN retried it 1 time without success. Refresh to start the research over.");
    expect(retryNote(undefined, NOW)).toBeNull();
  });
});

describe("a failed module", () => {
  const render = (module: ResearchModule) =>
    renderToStaticMarkup(createElement(ModuleFrame, { index: 5, title: "Bull vs bear", subtitle: "", module, schema: z.unknown(), children: () => null }));
  const failed: ResearchModule = { key: "bull_bear", status: "failed", payload: null, error: "LlmTransportError: LLM HTTP 503", updatedAt: NOW.toISOString() };

  it("says FINN is retrying it instead of showing the raw error", () => {
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const html = render({ ...failed, retry: { status: "pending", attempts: 1, nextAttemptAt: later } });
    expect(html).toContain("This module failed; FINN is retrying it");
    expect(html).toContain("The rest of the research is unaffected. FINN retries it automatically; next try around");
    expect(html).not.toContain("LLM HTTP 503");
  });

  it("says when the retries gave up, and falls back to the error when there is no retry", () => {
    const dead = render({ ...failed, retry: { status: "dead", attempts: 5, nextAttemptAt: null } });
    expect(dead).toContain("This module failed<");
    expect(dead).toContain("FINN retried it 5 times without success. Refresh to start the research over.");
    expect(render(failed)).toContain("LlmTransportError: LLM HTTP 503");
  });
});
