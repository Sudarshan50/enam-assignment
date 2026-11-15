import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertsApi, ApiError, companiesApi, digestApi, researchApi, systemApi } from "@/lib/api";
import * as f from "./fixtures/api";

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

/** Every request answers with `body`/`status`; calls are recorded for URL and payload assertions. */
function respond(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
      return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

async function rejectsContract(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(502);
  expect((error as ApiError).message).toMatch(/Unexpected response shape/);
}

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("http", () => {
  it("surfaces the server's error message and status", async () => {
    respond({ error: "locked", message: "Open the link you were sent." }, 401);
    const error = (await digestApi.getDigest("24h").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Open the link you were sent.");
  });

  it("falls back to a generic message for non-JSON errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    await expect(digestApi.getDigest("24h")).rejects.toThrow("Request failed (502)");
  });
});

describe("digestApi", () => {
  it("parses the live digest and asks for the window", async () => {
    respond(f.digest);
    const digest = await digestApi.getDigest("7d");
    expect(calls[0]).toMatchObject({ url: "/api/v1/digest?window=7d", method: "GET" });
    expect(digest.act[0]?.card?.kind).toBe("results");
    expect(digest.counts.know).toBe(1);
  });

  it("rejects a digest missing its counts", async () => {
    const { counts: _counts, ...broken } = f.digest;
    respond(broken);
    await rejectsContract(digestApi.getDigest("24h"));
  });

  it("rejects an unknown card kind", async () => {
    respond({ ...f.digest, know: [{ ...f.genericItem, card: { kind: "weather", oneLiner: null } }] });
    await rejectsContract(digestApi.getDigest("24h"));
  });

  it("accepts the announcement detail shape (DigestItem plus detail fields)", async () => {
    respond(f.announcementDetail);
    const item = await digestApi.getAnnouncement("DEMO-TCS-RESULTS");
    expect(calls[0]?.url).toBe("/api/v1/announcements/DEMO-TCS-RESULTS");
    expect(item.id).toBe("DEMO-TCS-RESULTS");
  });

  it("posts interactions with the body the API validates", async () => {
    respond({ ok: true, category: "results", weight: 0.9 }, 201);
    await digestApi.recordInteraction("106857341", "undo_dismiss");
    expect(calls[0]).toEqual({ url: "/api/v1/interactions", method: "POST", body: { seqId: "106857341", action: "undo_dismiss" } });
  });
});

describe("companiesApi", () => {
  it("accepts holdings as a bare array (live) or a { holdings } envelope", async () => {
    respond([f.holding]);
    expect((await companiesApi.getHoldings())[0]?.symbol).toBe("ADANIPORTS");
    respond({ holdings: [f.holding, f.holding] });
    expect(await companiesApi.getHoldings()).toHaveLength(2);
  });

  it("rejects a holding whose sparkline is not numeric", async () => {
    respond([{ ...f.holding, sparkline: "1,2,3" }]);
    await rejectsContract(companiesApi.getHoldings());
  });

  it("maps the API's isHolding onto inPortfolio", async () => {
    respond([{ ...f.searchResult, isHolding: true }]);
    const [hit] = await companiesApi.searchCompanies("CDS");
    expect(calls[0]?.url).toBe("/api/v1/companies/search?q=CDS");
    expect(hit).toMatchObject({ symbol: "CDSL", inPortfolio: true });
    expect(hit).not.toHaveProperty("isHolding");
  });

  it("keeps an explicit inPortfolio from a { results } envelope", async () => {
    respond({ results: [{ symbol: "CDSL", name: "CDSL", inPortfolio: false, researchReady: true }] });
    const [hit] = await companiesApi.searchCompanies("cdsl");
    expect(hit).toMatchObject({ inPortfolio: false, researchReady: true });
  });
});

describe("researchApi", () => {
  it("unwraps the live { symbol, run, modules, promiseLedger } envelope to the run", async () => {
    respond(f.companyResearch);
    const { run } = await researchApi.getResearchForSymbol("CDSL");
    expect(calls[0]?.url).toBe("/api/v1/companies/CDSL/research");
    expect(run?.id).toBe(f.run.id);
    expect(run?.status).toBe("completed");
  });

  it("returns run: null for a never-researched symbol", async () => {
    respond(f.companyResearchEmpty);
    expect((await researchApi.getResearchForSymbol("ZOMATO")).run).toBeNull();
  });

  it("also accepts a bare run or a null body", async () => {
    respond(f.run);
    expect((await researchApi.getResearchForSymbol("CDSL")).run?.id).toBe(f.run.id);
    respond(null);
    expect((await researchApi.getResearchForSymbol("CDSL")).run).toBeNull();
  });

  it("rejects an envelope whose run is off-contract", async () => {
    respond({ ...f.companyResearch, run: { ...f.run, status: "done" } });
    await rejectsContract(researchApi.getResearchForSymbol("CDSL"));
  });

  it("parses a cached start response and posts the symbol", async () => {
    respond(f.startRunCached);
    const res = await researchApi.startResearch("CDSL");
    expect(calls[0]).toEqual({ url: "/api/v1/research-runs", method: "POST", body: { symbol: "CDSL" } });
    expect(res).toEqual({ runId: f.run.id, status: "completed", cached: true });
  });

  it("rejects a start response with an unknown status", async () => {
    respond({ runId: "x", status: "started" });
    await rejectsContract(researchApi.startResearch("CDSL"));
  });

  it("parses a run and a cited ask answer", async () => {
    respond(f.run);
    expect((await researchApi.getRun(f.run.id)).modules).toHaveLength(2);
    respond(f.askAnswer);
    const answer = await researchApi.ask("CDSL", "What is revenue guidance?");
    expect(calls.at(-1)).toMatchObject({ url: "/api/v1/ask", method: "POST", body: { symbol: "CDSL", question: "What is revenue guidance?" } });
    expect(answer.answer[0]?.citations[0]?.page).toBe(4);
  });

  it("rejects an ask answer without the insufficientSources flag", async () => {
    respond({ answer: [] });
    await rejectsContract(researchApi.ask("CDSL", "anything?"));
  });
});

describe("alertsApi", () => {
  it("accepts alerts and rules as arrays (live) or envelopes", async () => {
    respond([f.alert]);
    expect(await alertsApi.getAlerts()).toHaveLength(1);
    respond({ alerts: [f.alert] });
    expect(await alertsApi.getAlerts()).toHaveLength(1);
    respond([f.rule]);
    expect((await alertsApi.getRules())[0]?.name).toBe("Big daily move");
    respond({ rules: [] });
    expect(await alertsApi.getRules()).toEqual([]);
  });

  it("rejects an alert with an unknown kind", async () => {
    respond([{ ...f.alert, kind: "news" }]);
    await rejectsContract(alertsApi.getAlerts());
  });

  it("maps the API's per-symbol backtest onto hits", async () => {
    respond(f.previewWithFires);
    const preview = await alertsApi.previewRule("Volume above 2.5x on DIXON or POLYCAB");
    expect(calls[0]).toMatchObject({ url: "/api/v1/alert-rules/preview", method: "POST" });
    expect(preview.backtest).toEqual({ fires: 1, sessions: 30, note: null, hits: [{ date: "2026-11-02", symbol: "DIXON", detail: "fired once" }] });
  });

  it("keeps per-session hits when the server sends them", async () => {
    const hits = [{ date: "2026-11-03", symbol: "HDFCBANK", detail: "−3.4%" }];
    respond({ ...f.previewWithFires, backtest: { fires: 1, sessions: 30, hits } });
    expect((await alertsApi.previewRule("bank falls 3%")).backtest?.hits).toEqual(hits);
  });

  it("accepts an unparsed preview (definition and backtest null)", async () => {
    respond(f.previewUnparsed);
    const preview = await alertsApi.previewRule("gibberish");
    expect(preview.definition).toBeNull();
    expect(preview.backtest).toBeNull();
  });

  it("rejects a preview definition outside the shared bounds", async () => {
    respond({ ...f.previewWithFires, definition: { ...f.previewWithFires.definition, multiple: 50 } });
    await rejectsContract(alertsApi.previewRule("volume 50x"));
  });

  it("creates, patches and deletes rules on the right routes", async () => {
    respond(f.rule, 201);
    await alertsApi.createRule({ name: f.rule.name, definition: f.rule.definition as never });
    respond({ ...f.rule, enabled: false });
    expect((await alertsApi.updateRule(f.rule.id, { enabled: false })).enabled).toBe(false);
    respond(null, 204);
    await alertsApi.deleteRule(f.rule.id);
    await alertsApi.markAlertRead(f.alert.id);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/v1/alert-rules",
      `PATCH /api/v1/alert-rules/${f.rule.id}`,
      `DELETE /api/v1/alert-rules/${f.rule.id}`,
      `POST /api/v1/alerts/${f.alert.id}/read`,
    ]);
  });
});

describe("systemApi", () => {
  it("parses live engine stats and prefs", async () => {
    respond(f.engine);
    const engine = await systemApi.getEngine();
    expect(engine.llm.callsToday).toBe(59);
    expect(engine.sourceHealth?.[0]?.source).toBe("nse_announcements");
    respond(f.prefs);
    expect((await systemApi.getPrefs()).defaultWindow).toBe("24h");
  });

  it("rejects engine stats missing the llm block", async () => {
    const { llm: _llm, ...broken } = f.engine;
    respond(broken);
    await rejectsContract(systemApi.getEngine());
  });

  it("reads the VAPID key in every shape the API may send", async () => {
    respond({ enabled: false, publicKey: null });
    expect(await systemApi.getVapidKey()).toBeNull();
    respond({ enabled: true, publicKey: "BPk" });
    expect(await systemApi.getVapidKey()).toBe("BPk");
    respond({ publicKey: "BPk2" });
    expect(await systemApi.getVapidKey()).toBe("BPk2");
    respond({ key: "legacy" });
    expect(await systemApi.getVapidKey()).toBe("legacy");
  });

  it("rejects a VAPID response with neither key field", async () => {
    respond({ enabled: true });
    await rejectsContract(systemApi.getVapidKey());
  });
});
