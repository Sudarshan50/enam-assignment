import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchResult } from "./fixtures/api";

const hooks = vi.hoisted(() => ({ search: {} as Record<string, unknown> }));

// The search box is controlled state; seed a typed query so the results panel renders on the server.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (init: unknown) => (init === "" ? ["CDS", () => {}] : actual.useState(init)) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/lib/hooks/data", () => ({
  useCompanySearch: () => hooks.search,
  useHoldings: () => ({ data: [], error: undefined, isLoading: false, mutate: () => {} }),
}));

const render = async () => {
  const { AskIndex } = await import("@/components/research/ask-index");
  return renderToStaticMarkup(createElement(AskIndex));
};

const match = { ...searchResult, inPortfolio: false, researchReady: true };

beforeEach(() => {
  hooks.search = { data: [], error: undefined, isLoading: false, mutate: () => {} };
});

describe("company search", () => {
  it("says the search failed, with a retry, instead of 'no listed match'", async () => {
    hooks.search = { data: [match], error: new Error("Request failed (502)"), isLoading: false, mutate: () => {} };
    const html = await render();
    expect(html).toContain("Search isn&#x27;t responding right now.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No listed match");
    expect(html).not.toContain('role="listbox"');
  });

  it("says there is no match only when the search succeeded empty", async () => {
    const html = await render();
    expect(html).toContain("No listed match");
    expect(html).not.toContain("Search isn&#x27;t responding");
  });

  it("lists matches when the search succeeds", async () => {
    hooks.search = { data: [match], error: undefined, isLoading: false, mutate: () => {} };
    const html = await render();
    expect(html).toContain('role="listbox"');
    expect(html).toContain("Central Depository Services");
  });
});
