// Live end-to-end checks against the real API through the Next dev server, driven over raw CDP.
//
//   1. npm run dev -w @finn/api                                     (repo root, port 4000)
//   2. cd apps/web && API_ORIGIN=http://localhost:4000 DEMO_ACCESS_TOKEN=... npx next dev --port 3000
//   3. cd apps/web && npm run e2e                                    (loads ../../.env for DEMO_ACCESS_TOKEN; never prints it)
//
// Options (env): E2E_BASE (default http://localhost:3000), E2E_ASK=0 to skip the one live LLM question,
// CHROME (path to a Chrome binary), E2E_HEADFUL=1.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.E2E_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.DEMO_ACCESS_TOKEN;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../.screenshots/e2e/", import.meta.url).pathname;
const PORT = 9334;
const ASK_ENABLED = process.env.E2E_ASK !== "0";

if (!TOKEN) {
  console.error("DEMO_ACCESS_TOKEN is not set. Run: node --env-file=../../.env e2e/run.mjs");
  process.exit(2);
}
const redact = (s) => String(s).split(TOKEN).join("<token>").replace(/([?&]k=)[^&\s"]+/g, "$1<redacted>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.startsWith("FAIL-")) rmSync(join(OUT, f));

// ---------------------------------------------------------------------------------------------
// Chrome + CDP plumbing
// ---------------------------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "finn-e2e-"));
const chrome = spawn(
  CHROME,
  [
    ...(process.env.E2E_HEADFUL ? [] : ["--headless=new"]),
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let seq = 0;
const pending = new Map();
const listeners = new Map();
const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connect() {
  let wsUrl;
  for (let i = 0; i < 75 && !wsUrl; i++) {
    await sleep(200);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      wsUrl = pages.find((p) => p.type === "page")?.webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) throw new Error("Chrome did not expose a page target");
  ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  });
}

// ---------------------------------------------------------------------------------------------
// Network + console capture
// ---------------------------------------------------------------------------------------------
let phase = "setup";
const requests = new Map(); // requestId -> { url, method, status, mime, phase, sse: [] }
const consoleErrors = [];
const consoleWarnings = [];

function track() {
  on("Network.requestWillBeSent", ({ requestId, request, type }) => {
    requests.set(requestId, { requestId, url: request.url, method: request.method, type, phase, status: null, mime: null, failed: null, sse: [] });
  });
  on("Network.responseReceived", ({ requestId, response }) => {
    const r = requests.get(requestId);
    if (r) Object.assign(r, { status: response.status, mime: response.mimeType });
  });
  on("Network.loadingFailed", ({ requestId, errorText, canceled }) => {
    const r = requests.get(requestId);
    if (r) r.failed = canceled ? "canceled" : errorText;
  });
  on("Network.eventSourceMessageReceived", ({ requestId, eventName, eventId, data }) => {
    requests.get(requestId)?.sse.push({ eventName, eventId, data });
  });
  on("Runtime.consoleAPICalled", ({ type, args }) => {
    const text = redact(args.map((a) => a.value ?? a.description ?? a.type).join(" ")).slice(0, 400);
    if (type === "error" || type === "assert") consoleErrors.push({ phase, text });
    else if (type === "warning") consoleWarnings.push({ phase, text });
  });
  on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    consoleErrors.push({ phase, text: redact(exceptionDetails.exception?.description ?? exceptionDetails.text).slice(0, 400) });
  });
  on("Log.entryAdded", ({ entry }) => {
    // Network failures already show up via Network.*; keep only non-network browser errors.
    if (entry.level === "error" && entry.source !== "network") consoleErrors.push({ phase, text: redact(entry.text).slice(0, 400) });
  });
}

const apiRequests = (filter = () => true) => [...requests.values()].filter((r) => new URL(r.url).pathname.startsWith("/api/") && filter(r));
const isBadApi = (r) => (r.status !== null && r.status >= 400) || (r.failed && r.failed !== "canceled");

// ---------------------------------------------------------------------------------------------
// Page helpers (functions are serialised into the page)
// ---------------------------------------------------------------------------------------------
async function evaluate(fn, ...args) {
  // DOM nodes can't be returned by value; predicates may return one to mean "found".
  const expression = `(async () => { const v = await (${fn.toString()})(...${JSON.stringify(args)}); return v instanceof Node ? true : v; })()`;
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(redact(exceptionDetails.exception?.description ?? exceptionDetails.text));
  return result.value;
}

async function waitFor(label, fn, args = [], timeout = 30_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await evaluate(fn, ...args);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ""}`);
}

async function waitForNetwork(label, predicate, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const hit = [...requests.values()].find(predicate);
    if (hit && (hit.status !== null || hit.failed)) return hit;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for network: ${label}`);
}

async function navigate(path, ready) {
  await send("Page.navigate", { url: BASE + path });
  await waitFor(`${path} to load`, () => document.readyState === "complete" && !!document.querySelector("main"));
  if (ready) await waitFor(`${path} content`, ready);
}

async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  shots.push(`${name}.png`);
}

async function viewport(width, height, mobile) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
}

async function responseJson(requestId) {
  const { body, base64Encoded } = await send("Network.getResponseBody", { requestId });
  return JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body);
}

async function pressEscape() {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

// In-page helpers -----------------------------------------------------------------------------
function overflowReport() {
  const vw = window.innerWidth;
  const extra = document.documentElement.scrollWidth - vw;
  if (extra <= 1) return { ok: true, extra };
  const offenders = [...document.querySelectorAll("body *")]
    .filter((el) => el.getBoundingClientRect().right > vw + 1 && getComputedStyle(el).position !== "fixed")
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
  return { ok: false, extra, offenders };
}

function clickEl(selector, textPattern) {
  const re = textPattern ? new RegExp(textPattern, "i") : null;
  const el = [...document.querySelectorAll(selector)].find((e) => !re || re.test(e.textContent ?? "") || re.test(e.getAttribute("aria-label") ?? ""));
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
}

function setValue(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------
const results = [];
const shots = [];
const notes = [];

async function step(name, fn) {
  phase = name;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "", ms: Date.now() - started });
    console.log(`  ✓ ${name}${detail ? ` — ${redact(detail)}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: redact(e.message), ms: Date.now() - started });
    console.log(`  ✗ ${name} — ${redact(e.message)}`);
    await screenshot(`FAIL-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`).catch(() => {});
  }
}

async function checkOverflow(label) {
  const report = await evaluate(overflowReport);
  if (!report.ok) throw new Error(`${label}: horizontal overflow of ${report.extra}px (${report.offenders.join(", ")})`);
}

async function run() {
  await connect();
  track();
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  await viewport(390, 844, true);

  console.log(`FINN live e2e → ${BASE}\n`);

  await step("locked without a cookie", async () => {
    await send("Page.navigate", { url: `${BASE}/` });
    await waitFor("locked page", () => /link/i.test(document.body?.innerText ?? "") && !document.querySelector("section[aria-labelledby='sec-act']"));
    const status = await evaluate(async () => (await fetch("/api/v1/digest?window=24h")).status);
    if (status !== 401) throw new Error(`expected /api/v1/digest → 401 without cookie, got ${status}`);
    await screenshot("locked-390");
    return "page shows the locked screen; API answers 401";
  });
  requests.clear(); // the expected 401 above is not a failure

  await step("?k sets the cookie and lands on Today with live digest", async () => {
    await send("Page.navigate", { url: `${BASE}/?k=${encodeURIComponent(TOKEN)}` });
    await waitFor("redirect to clean URL", () => location.pathname === "/" && !location.search.includes("k="));
    const { cookies } = await send("Network.getCookies", { urls: [BASE] });
    const cookie = cookies.find((c) => c.name === "finn_access");
    if (!cookie) throw new Error("finn_access cookie not set");
    if (!cookie.httpOnly) throw new Error("finn_access cookie is not httpOnly");
    if (cookie.value !== TOKEN) throw new Error("finn_access cookie value does not match the link token");
    const digest = await waitForNetwork("GET /digest", (r) => r.url.includes("/api/v1/digest") && r.status !== null);
    if (digest.status !== 200) throw new Error(`/digest → ${digest.status}`);
    const body = await responseJson(digest.requestId);
    const want = { act: body.act.length, know: body.know.length };
    const counts = await waitFor("digest sections match the API", (w) => {
      const n = (t) => document.querySelectorAll(`section[aria-labelledby='sec-${t}'] article`).length;
      const caughtUp = /caught up/i.test(document.body.textContent);
      const got = { act: n("act"), know: n("know"), caughtUp };
      if (w.act + w.know === 0) return caughtUp ? got : null;
      return got.act === w.act && got.know === w.know ? got : null;
    }, [want]);
    await sleep(800);
    const zod = consoleErrors.filter((e) => /contract|zod|Unexpected response/i.test(e.text));
    if (zod.length) throw new Error(`contract errors: ${zod.map((e) => e.text).join(" | ")}`);
    await checkOverflow("Today");
    await screenshot("today-390");
    return `httpOnly cookie set, URL cleaned; UI matches /digest: act ${counts.act}, know ${counts.know}${counts.caughtUp ? " (caught up)" : ""}`;
  });

  const openResults = () => {
    const article = [...document.querySelectorAll("section[aria-labelledby='sec-act'] article")].find((a) => /Financial Results/i.test(a.textContent ?? ""));
    const button = article?.querySelector("button[aria-expanded]");
    if (!button) return null;
    button.click();
    return article.getAttribute("aria-label");
  };

  await step("results card shows Revenue/EBITDA/PAT with QoQ/YoY (TCS)", async () => {
    let opened = await evaluate(openResults);
    if (!opened) {
      notes.push("24h window had no results card at run time; results check used the 7d window.");
      await navigate("/?window=7d", () => document.querySelectorAll("section[aria-labelledby='sec-act'] article").length > 0);
      await sleep(800);
      opened = await evaluate(openResults);
    }
    if (!opened) throw new Error("no results card in the act section (24h or 7d)");
    const table = await waitFor("results table", (label) => {
      const article = [...document.querySelectorAll("article")].find((a) => a.getAttribute("aria-label") === label);
      const t = article?.querySelector("table");
      if (!t) return null;
      const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      const rows = [...t.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("th")?.textContent.trim());
      const deltas = [...t.querySelectorAll("tbody td")].map((td) => td.textContent.trim()).filter((s) => /%$/.test(s));
      return { heads, rows, deltas };
    }, [opened]);
    for (const h of ["QoQ", "YoY"]) if (!table.heads.some((x) => x.includes(h))) throw new Error(`missing ${h} column: ${table.heads}`);
    for (const m of ["Revenue", "EBITDA", "PAT"]) if (!table.rows.some((r) => r?.startsWith(m))) throw new Error(`missing ${m} row: ${table.rows}`);
    if (table.deltas.some((d) => d.includes("-"))) throw new Error(`hyphen-minus in deltas: ${table.deltas}`);
    await sleep(700);
    await screenshot("today-results-expanded-390");
    return `rows ${table.rows.join("/")}; deltas ${table.deltas.slice(0, 4).join(" ")}`;
  });

  await step("results card with PBT (7d, MARUTI)", async () => {
    await navigate("/?window=7d", () => document.querySelectorAll("section[aria-labelledby='sec-act'] article").length > 0);
    await waitFor("7d window applied", () => [...document.querySelectorAll("article")].some((a) => /MARUTI|Maruti/.test(a.getAttribute("aria-label") ?? a.textContent)), [], 15_000);
    const label = await evaluate(() => {
      const article = [...document.querySelectorAll("section[aria-labelledby='sec-act'] article")].find(
        (a) => /Maruti/i.test(a.getAttribute("aria-label") ?? "") && /result/i.test(a.textContent ?? ""),
      );
      article?.querySelector("button[aria-expanded]")?.click();
      return article?.getAttribute("aria-label") ?? null;
    });
    if (!label) throw new Error("no MARUTI results card in 7d act section");
    const rows = await waitFor("MARUTI table", (l) => {
      const t = [...document.querySelectorAll("article")].find((a) => a.getAttribute("aria-label") === l)?.querySelector("table");
      return t ? [...t.querySelectorAll("tbody tr th")].map((th) => th.textContent.trim()) : null;
    }, [label]);
    for (const m of ["Revenue", "EBITDA", "PBT", "PAT"]) if (!rows.some((r) => r.startsWith(m))) throw new Error(`missing ${m}: ${rows}`);
    await sleep(600);
    await screenshot("today-7d-maruti-results-390");
    notes.push("No banking results card exists in the live digest, so NII/PPOP rendering was only covered by unit/mocks.");
    return rows.join("/");
  });

  await step("dismiss + Undo", async () => {
    await navigate("/?window=7d", () => document.querySelectorAll("section[aria-labelledby='sec-know'] article").length > 0);
    await sleep(800);
    const target = await evaluate(() => {
      const article = [...document.querySelectorAll("section[aria-labelledby='sec-know'] article")].find((a) => a.querySelector("button[aria-label^='Dismiss ']"));
      if (!article) return null;
      article.querySelector("button[aria-label^='Dismiss ']").click();
      return article.getAttribute("aria-label");
    });
    if (!target) throw new Error("no dismissible know item");
    await waitFor("item removed", (l) => ![...document.querySelectorAll("article")].some((a) => a.getAttribute("aria-label") === l), [target], 8000);
    await waitFor("Undo toast", () => [...document.querySelectorAll("[role=status] button")].some((b) => b.textContent.trim() === "Undo"), [], 5000);
    await screenshot("today-dismissed-toast-390");
    const interaction = await waitForNetwork("POST /interactions dismiss", (r) => r.url.endsWith("/api/v1/interactions") && r.method === "POST" && r.phase === phase);
    await evaluate(clickEl, "[role=status] button", "^Undo$");
    await waitFor("item restored", (l) => [...document.querySelectorAll("article")].some((a) => a.getAttribute("aria-label") === l), [target], 8000);
    const stored = await evaluate(() => localStorage.getItem("finn:dismissed"));
    const undoCalls = apiRequests((r) => r.url.endsWith("/interactions") && r.phase === phase).length;
    if (undoCalls < 2) throw new Error(`expected dismiss + undo_dismiss interactions, saw ${undoCalls}`);
    return `dismissed then restored; POST /interactions → ${interaction.status}; stored ${stored}`;
  });

  await step("/holdings shows 18 rows with sparklines", async () => {
    await navigate("/holdings", () => document.querySelectorAll("li a[href^='/ask/'] svg[role=img]").length >= 18);
    const info = await evaluate(() => {
      const rows = [...document.querySelectorAll("li a[href^='/ask/']")];
      const sparks = rows.filter((r) => {
        const path = r.querySelector("svg[role=img] path, svg[role=img] polyline");
        return path && (path.getAttribute("d") || path.getAttribute("points") || "").length > 20;
      });
      return { rows: rows.length, sparks: sparks.length, prices: rows.filter((r) => /₹[\d,]+\.\d\d/.test(r.textContent)).length };
    });
    if (info.rows !== 18 || info.sparks !== 18) throw new Error(`rows ${info.rows}, sparklines ${info.sparks}`);
    if (info.prices !== 18) throw new Error(`only ${info.prices} rows show a price`);
    await checkOverflow("Holdings");
    await screenshot("holdings-390");
    return `${info.rows} rows, ${info.sparks} sparklines, ${info.prices} prices`;
  });

  let cdslRunId = null;
  await step("/ask/CDSL renders stored research (ledger, snapshot, bull/bear + citations)", async () => {
    await navigate("/ask/CDSL", () => /Research ready/.test(document.body.innerText));
    const state = await waitFor("modules rendered", () => {
      const sec = (id) => document.getElementById(id);
      const ledger = sec("promise_ledger")?.querySelector("[aria-label^='Delivered '], [aria-label^='None due yet']")?.getAttribute("aria-label");
      const snapshot = sec("financial_snapshot")?.innerText ?? "";
      const bb = sec("bull_bear");
      const chips = bb ? bb.querySelectorAll("button[aria-label^='Source:']").length : 0;
      const broken = document.body.innerText.match(/unexpected shape|This module failed/g) ?? [];
      return ledger && chips > 0 ? { ledger, snapshotLen: snapshot.length, chips, broken, bull: /bull/i.test(bb.innerText), bear: /bear/i.test(bb.innerText) } : null;
    });
    if (state.broken.length) throw new Error(`module notices: ${state.broken.join(", ")}`);
    if (state.snapshotLen < 80) throw new Error("financial snapshot looks empty");
    const research = [...requests.values()].find((r) => r.url.includes("/api/v1/companies/CDSL/research"));
    if (research) cdslRunId = (await responseJson(research.requestId)).run?.id ?? null;
    await checkOverflow("Ask CDSL");
    await screenshot("ask-cdsl-390");
    return `${state.ledger}; ${state.chips} citation chips in bull/bear`;
  });

  await step("citation sheet opens with quote + page", async () => {
    await evaluate(() => {
      const chip = [...document.querySelectorAll("#bull_bear button[aria-label^='Source:']")].find((b) => /page \d+/.test(b.getAttribute("aria-label"))) ??
        document.querySelector("#bull_bear button[aria-label^='Source:']");
      chip.scrollIntoView({ block: "center" });
      chip.click();
    });
    const sheet = await waitFor("citation dialog", () => {
      const d = document.querySelector("[role=dialog]");
      const quote = d?.querySelector("blockquote")?.textContent.trim();
      return quote ? { quote: quote.slice(0, 80), page: (d.innerText.match(/page \d+/) ?? [null])[0], title: d.querySelector("h2")?.textContent } : null;
    });
    await sleep(500);
    await screenshot("ask-cdsl-citation-390");
    if (!sheet.page) throw new Error(`no page number in citation sheet (title ${sheet.title})`);
    await pressEscape();
    await waitFor("dialog closed", () => !document.querySelector("[role=dialog]"), [], 5000);
    return `${sheet.title} · ${sheet.page} · ${sheet.quote}`;
  });

  await step("SSE through the Next rewrite (cached CDSL run)", async () => {
    const stream = await waitForNetwork(
      "EventSource /research-runs/:id/events",
      (r) => /\/api\/v1\/research-runs\/[0-9a-f-]{36}\/events/.test(r.url) && r.phase === "/ask/CDSL renders stored research (ledger, snapshot, bull/bear + citations)",
      10_000,
    );
    if (stream.status !== 200 || stream.mime !== "text/event-stream") throw new Error(`events → ${stream.status} ${stream.mime}`);
    const types = stream.sse.map((m) => m.eventName);
    if (!types.includes("run.completed")) throw new Error(`no run.completed replayed (got ${types.join(",")})`);
    const ids = stream.sse.filter((m) => m.eventId).map((m) => Number(m.eventId));
    if (ids.some((id, i) => i > 0 && id <= ids[i - 1])) throw new Error("event ids not increasing");
    const reconnects = [...requests.values()].filter((r) => r.url === stream.url).length;
    if (reconnects > 1) throw new Error(`EventSource reconnected ${reconnects - 1}× after a terminal run`);

    // Refresh = POST /research-runs; for a run completed within the cache TTL this must come back cached.
    const before = await evaluate(async () => (await (await fetch("/api/v1/companies/CDSL/research")).json()).run);
    if (before?.status !== "completed") throw new Error(`CDSL has no completed run (status ${before?.status}); refusing to start a new one`);
    await evaluate(clickEl, "button", "^\\s*Refresh\\s*$");
    const post = await waitForNetwork("POST /research-runs", (r) => r.url.endsWith("/api/v1/research-runs") && r.method === "POST", 15_000);
    const body = await responseJson(post.requestId);
    if (!body.cached || body.runId !== before.id) throw new Error(`expected cached run ${before.id}, got ${JSON.stringify(body)}`);
    await waitFor("from cache label", () => /from cache/.test(document.body.innerText) && /Research ready/.test(document.body.innerText), [], 10_000);

    // Direct stream check through the rewrite: frames arrive and the server closes with `end`.
    const direct = await evaluate(
      (runId) =>
        new Promise((resolve) => {
          const seen = [];
          const es = new EventSource(`/api/v1/research-runs/${runId}/events`);
          const done = (why) => {
            es.close();
            resolve({ seen, why });
          };
          for (const t of ["run.queued", "run.started", "module.completed", "run.completed", "end"]) es.addEventListener(t, () => (seen.push(t), t === "end" && done("end")));
          es.onerror = () => done("error");
          setTimeout(() => done("timeout"), 10_000);
        }),
      body.runId,
    );
    if (direct.why !== "end" || !direct.seen.includes("run.completed")) throw new Error(`direct stream: ${JSON.stringify(direct)}`);
    return `page stream 200 text/event-stream, ${stream.sse.length} frames, no reconnects; POST → ${post.status} cached; direct stream ended with 'end'`;
  });

  await step("/ask/ASTRAL shows the Promise Ledger fraction", async () => {
    await navigate("/ask/ASTRAL", () => /Research ready/.test(document.body.innerText) && document.querySelector("#promise_ledger [aria-label^='Delivered ']"));
    const shown = await evaluate(() => {
      const el = document.querySelector("#promise_ledger [aria-label^='Delivered ']");
      return { label: el.getAttribute("aria-label"), text: el.textContent.replace(/\s+/g, " ").trim(), broken: /unexpected shape/.test(document.body.innerText) };
    });
    const research = await evaluate(async () => (await (await fetch("/api/v1/companies/ASTRAL/research")).json()));
    const s = research.run.modules.find((m) => m.key === "promise_ledger")?.payload?.summary;
    if (s.elapsed === 0) throw new Error(`ASTRAL ledger has no elapsed promises (${JSON.stringify(s)}); expected a fraction to show`);
    const expected = `Delivered ${s.delivered} of ${s.elapsed}`;
    if (shown.label !== expected) throw new Error(`UI says "${shown.label}", module payload says "${expected}"`);
    if (shown.broken) throw new Error("a module rendered the unexpected-shape notice");
    if (research.promiseLedger && research.promiseLedger.summary.elapsed !== s.elapsed) {
      notes.push(
        `ASTRAL: envelope promiseLedger.summary (${JSON.stringify(research.promiseLedger.summary)}, ${research.promiseLedger.promises.length} promises) ≠ run module payload summary (${JSON.stringify(s)}, ${research.run.modules.find((m) => m.key === "promise_ledger").payload.promises.length} promises). UI renders the module payload.`,
      );
    }
    await checkOverflow("Ask ASTRAL");
    await screenshot("ask-astral-390");
    return `"${shown.text}" matches module summary`;
  });

  if (ASK_ENABLED) {
    await step("ask a question (POST /ask, live LLM — 1 call)", async () => {
      await navigate("/ask/CDSL", () => /Research ready/.test(document.body.innerText) && document.querySelector("#ask-input"));
      await evaluate(setValue, "#ask-input", "How did operational revenue and EBITDA change in FY 2025-26?");
      await waitFor("Ask enabled", () => !document.querySelector("button[aria-label=Ask]").disabled, [], 5000);
      await evaluate(clickEl, "button[aria-label=Ask]");
      const post = await waitForNetwork("POST /ask", (r) => r.url.endsWith("/api/v1/ask") && r.method === "POST", 120_000);
      if (post.status !== 200) throw new Error(`/ask → ${post.status}`);
      const body = await responseJson(post.requestId);
      const first = body.answer[0]?.text?.slice(0, 40);
      await waitFor("answer rendered", (snippet, insufficient) => {
        const text = document.querySelector("section[aria-labelledby='ask-title']")?.innerText ?? "";
        return insufficient ? /don.t answer|not enough|insufficient/i.test(text) : text.includes(snippet);
      }, [first ?? "", body.insufficientSources || body.answer.length === 0], 15_000).catch((e) => {
        throw new Error(`${e.message}; API said ${JSON.stringify({ claims: body.answer.length, insufficientSources: body.insufficientSources, first })}`);
      });
      const chips = await evaluate(() => document.querySelectorAll("section[aria-labelledby='ask-title'] button[aria-label^='Source:']").length);
      await evaluate(() => document.querySelector("section[aria-labelledby='ask-title']")?.scrollIntoView({ block: "end" }));
      await sleep(400);
      await screenshot("ask-cdsl-answer-390");
      return `${body.answer.length} claims, ${chips} citation chips, insufficientSources=${body.insufficientSources}`;
    });
  }

  await step("/watch: NL rule → preview + backtest → save → delete (ZTW)", async () => {
    await navigate("/watch", () => [...document.querySelectorAll("button")].some((b) => /New rule/.test(b.textContent)));
    // Clean up leftovers from an aborted earlier run.
    await evaluate(async () => {
      const rules = await (await fetch("/api/v1/alert-rules")).json();
      for (const r of rules.filter((x) => x.name.startsWith("ZTW"))) await fetch(`/api/v1/alert-rules/${r.id}`, { method: "DELETE" });
    });
    await evaluate(clickEl, "button", "New rule");
    await waitFor("rule sheet", () => document.querySelector("[role=dialog] #rule-text"));
    const text = "ZTW volume above 2.5x on DIXON or POLYCAB";
    await evaluate(setValue, "#rule-text", text);
    await waitFor("Preview enabled", () => [...document.querySelectorAll("[role=dialog] button")].some((b) => /Preview rule/.test(b.textContent) && !b.disabled), [], 5000);
    await evaluate(clickEl, "[role=dialog] button", "Preview rule");
    const preview = await waitFor("preview + backtest", () => {
      const d = document.querySelector("[role=dialog]");
      const dl = d?.querySelector("dl")?.innerText;
      const bt = d?.querySelector("[role=img][aria-label^='Fired']")?.getAttribute("aria-label");
      return dl && bt ? { dl: dl.replace(/\s+/g, " "), bt, hits: [...d.querySelectorAll("ul li")].map((li) => li.textContent.trim()), quiet: /Quiet over this period/.test(d.innerText) } : null;
    });
    const fires = Number(preview.bt.match(/Fired (\d+)/)?.[1]);
    if (fires > 0 && preview.quiet) throw new Error(`backtest says it fired ${fires}× but also "Quiet over this period"`);
    if (fires > 0 && preview.hits.length === 0) throw new Error("backtest fired but lists no symbols");
    await sleep(500);
    await screenshot("watch-preview-390");
    await evaluate(clickEl, "[role=dialog] button", "Save rule");
    const create = await waitForNetwork("POST /alert-rules", (r) => r.url.endsWith("/api/v1/alert-rules") && r.method === "POST", 10_000);
    if (create.status !== 201) throw new Error(`POST /alert-rules → ${create.status}`);
    await waitFor("rule in list", (t) => [...document.querySelectorAll("section[aria-labelledby='rules-title'] li")].some((li) => li.textContent.includes(t)), [text], 10_000);
    await waitFor("sheet closed", () => !document.querySelector("[role=dialog]"), [], 5000);
    await sleep(400);
    await screenshot("watch-saved-390");
    await evaluate(clickEl, `button[aria-label^="Delete rule: ZTW"]`);
    const del = await waitForNetwork("DELETE /alert-rules/:id", (r) => /\/api\/v1\/alert-rules\/[0-9a-f-]{36}$/.test(r.url) && r.method === "DELETE", 10_000);
    await waitFor("rule gone", (t) => ![...document.querySelectorAll("section[aria-labelledby='rules-title'] li")].some((li) => li.textContent.includes(t)), [text], 10_000);
    const leftover = await evaluate(async () => (await (await fetch("/api/v1/alert-rules")).json()).filter((r) => r.name.startsWith("ZTW")).length);
    if (leftover) throw new Error(`${leftover} ZTW rule(s) still on the server`);
    await checkOverflow("Watch");
    return `${preview.dl} | ${preview.bt} | hits: ${preview.hits.join("; ") || "none"} | DELETE → ${del.status}`;
  });

  await step("/engine renders live stats", async () => {
    // textContent, not innerText: kicker labels are CSS-uppercased.
    await navigate("/engine", () => /Cache hits/i.test(document.body.textContent) && document.querySelector("table tbody tr"));
    // Compare against the response the page rendered (other processes may change stats meanwhile).
    const req = [...requests.values()].filter((r) => r.url.endsWith("/api/v1/engine") && r.status === 200 && r.phase === phase).at(-1);
    if (!req) throw new Error("page never fetched /api/v1/engine");
    const engine = await responseJson(req.requestId);
    const ui = await evaluate(() => ({
      rows: document.querySelectorAll("table tbody tr").length,
      sources: document.querySelectorAll("section[aria-labelledby='health-title'] li").length,
    }));
    if (ui.rows !== engine.byPurpose.length) throw new Error(`table rows ${ui.rows} ≠ byPurpose ${engine.byPurpose.length}`);
    if (ui.sources !== engine.sourceHealth.length) throw new Error(`source rows ${ui.sources} ≠ sourceHealth ${engine.sourceHealth.length}`);
    await checkOverflow("Engine");
    await screenshot("engine-390");
    return `${ui.rows} purpose rows, ${engine.sourceHealth.length} sources, ${engine.llm.callsToday} LLM calls today`;
  });

  await step("desktop 1440×900: pages render without overflow", async () => {
    await viewport(1440, 900, false);
    const pages = [
      ["/", "today-1440", () => document.querySelectorAll("section[aria-labelledby='sec-act'] article").length > 0 || /caught up/i.test(document.body.textContent)],
      ["/holdings", "holdings-1440", () => document.querySelectorAll("li a[href^='/ask/'] svg[role=img]").length >= 18],
      ["/ask/CDSL", "ask-cdsl-1440", () => /Research ready/.test(document.body.innerText) && document.querySelector("#bull_bear button[aria-label^='Source:']")],
      ["/ask/ASTRAL", "ask-astral-1440", () => document.querySelector("#promise_ledger [aria-label^='Delivered ']")],
      ["/watch", "watch-1440", () => document.querySelector("section[aria-labelledby='rules-title'] li")],
      ["/engine", "engine-1440", () => /Cache hits/i.test(document.body.textContent)],
    ];
    for (const [path, name, ready] of pages) {
      await navigate(path, ready);
      await sleep(600);
      await checkOverflow(`${path} @1440`);
      await screenshot(name);
    }
    await viewport(390, 844, true);
    return `${pages.length} pages`;
  });

  phase = "final";
  await step("no failed /api requests or console errors", async () => {
    const bad = apiRequests(isBadApi).map((r) => `${r.method} ${new URL(r.url).pathname} → ${r.status ?? r.failed} [${r.phase}]`);
    const errs = consoleErrors.map((e) => `[${e.phase}] ${e.text}`);
    if (bad.length || errs.length) throw new Error([...bad, ...errs].join("\n      "));
    return `${apiRequests().length} /api requests, all ok; ${consoleWarnings.length} console warnings`;
  });
}

let exitCode = 0;
try {
  await run();
} catch (e) {
  console.error("e2e aborted:", redact(e.stack ?? e.message));
  exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {}
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
}

const failed = results.filter((r) => !r.ok);
if (consoleWarnings.length) {
  console.log(`\nConsole warnings (${consoleWarnings.length}):`);
  for (const w of consoleWarnings.slice(0, 10)) console.log(`  [${w.phase}] ${w.text}`);
}
if (notes.length) {
  console.log("\nNotes:");
  for (const n of notes) console.log(`  - ${redact(n)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} steps passed. Screenshots: ${shots.length} in .screenshots/e2e/`);
writeFileSync(join(OUT, "report.json"), redact(JSON.stringify({ base: BASE, results, notes, warnings: consoleWarnings, shots }, null, 2)));
process.exit(failed.length || exitCode ? 1 : 0);
