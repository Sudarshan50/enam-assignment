import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { alert, engine, holding, rule } from "./fixtures/api";

const hooks = vi.hoisted(() => ({
  alerts: {} as Record<string, unknown>,
  rules: {} as Record<string, unknown>,
  holdings: {} as Record<string, unknown>,
  engine: {} as Record<string, unknown>,
  research: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/lib/hooks/data", () => ({
  useAlerts: () => hooks.alerts,
  useAlertRules: () => hooks.rules,
  useHoldings: () => hooks.holdings,
  useEngine: () => hooks.engine,
}));
vi.mock("@/lib/hooks/use-research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hooks/use-research")>()),
  useResearch: () => hooks.research,
}));

const failed = (message = "Request failed (500)") => ({ data: undefined, error: new Error(message), isLoading: false, mutate: () => {} });
const loaded = <T>(data: T) => ({ data, error: undefined, isLoading: false, mutate: () => {} });

async function render(load: () => Promise<ComponentType>, wrap = false): Promise<string> {
  const Component = await load();
  if (!wrap) return renderToStaticMarkup(createElement(Component));
  const { ToastProvider } = await import("@/components/ui/toast");
  return renderToStaticMarkup(createElement(ToastProvider, null, createElement(Component)));
}

const alertsFeed = () => import("@/components/alerts/alerts-feed").then((m) => m.AlertsFeed);
const rulesList = () => import("@/components/alerts/rules-list").then((m) => m.RulesList);
const todayAside = () => import("@/components/digest/today-aside").then((m) => m.TodayAside);
const engineScreen = () => import("@/components/engine/engine-screen").then((m) => m.EngineScreen);

beforeEach(() => {
  hooks.alerts = loaded([]);
  hooks.rules = loaded([]);
  hooks.holdings = loaded([]);
  hooks.engine = loaded(engine);
});

describe("Watch: alerts", () => {
  it("shows an error with a retry, not 'all read', when GET /alerts fails", async () => {
    hooks.alerts = failed();
    const html = await render(alertsFeed);
    expect(html).toContain("Couldn&#x27;t load this");
    expect(html).toContain("Try again");
    expect(html).not.toContain("all read");
    expect(html).not.toContain("No alerts yet");
  });

  it("shows the empty state only for a successful empty list", async () => {
    const html = await render(alertsFeed);
    expect(html).toContain("all read");
    expect(html).toContain("No alerts yet");
    expect(html).not.toContain("Try again");
  });

  it("counts unread alerts when they load", async () => {
    hooks.alerts = loaded([alert]);
    expect(await render(alertsFeed)).toContain("1 unread");
  });
});

describe("Watch: rules", () => {
  it("shows an error with a retry when GET /alert-rules fails", async () => {
    hooks.rules = failed();
    const html = await render(rulesList, true);
    expect(html).toContain("Your rules didn&#x27;t load");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No rules yet");
  });

  it("says there are no rules only when the list loaded empty", async () => {
    expect(await render(rulesList, true)).toContain("No rules yet");
    hooks.rules = loaded([rule]);
    const html = await render(rulesList, true);
    expect(html).toContain("Big daily move");
    expect(html).not.toContain("No rules yet");
  });
});

describe("Today aside", () => {
  it("shows an error per section instead of an empty list", async () => {
    hooks.holdings = failed();
    hooks.alerts = failed();
    const html = await render(todayAside);
    expect(html).toContain("Prices didn&#x27;t load");
    expect(html).toContain("Alerts didn&#x27;t load");
    expect(html).not.toContain("No holdings to show yet");
    expect(html).not.toContain("No alerts have triggered");
  });

  it("shows empty copy for successful empty responses", async () => {
    const html = await render(todayAside);
    expect(html).toContain("No holdings to show yet");
    expect(html).toContain("No alerts have triggered");
    expect(html).not.toContain("Try again");
  });

  it("lists movers when holdings load", async () => {
    hooks.holdings = loaded([holding]);
    expect(await render(todayAside)).toContain("ADANIPORTS");
  });
});

describe("Engine", () => {
  it("labels calls by purpose in plain English", async () => {
    const html = await render(engineScreen);
    expect(html).toContain("Reading guidance from calls");
    expect(html).not.toContain("guidance_extract");
  });
});

describe("Research screen", () => {
  const researchScreen = () => import("@/components/research/research-screen").then((m) => () => m.ResearchScreen({ symbol: "CDSL" }));
  const base = { run: null, events: [], transport: "idle", cached: false, rebuild: async () => {} };

  it("stops showing waiting modules when the run could not start", async () => {
    hooks.research = { ...base, starting: false, error: new Error("Request failed (503)") };
    const html = await render(researchScreen);
    expect(html).toContain("Research on CDSL couldn&#x27;t start");
    expect(html).toContain("Try again");
    const hidden = html.indexOf('<div hidden="">');
    expect(hidden).toBeGreaterThan(-1);
    expect(html.indexOf("Waiting for documents")).toBeGreaterThan(hidden);
  });

  it("keeps the modules visible while the run is starting", async () => {
    hooks.research = { ...base, starting: true, error: null };
    const html = await render(researchScreen);
    expect(html).not.toContain('hidden=""');
    expect(html).not.toContain("Try again");
  });
});
