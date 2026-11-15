// Phone layout checks: every screen and sheet at common phone widths, against a running web app.
//
//   cd apps/web && E2E_BASE=https://enam.cflowx.in npm run e2e:mobile
//
// Options (env): E2E_BASE (default http://localhost:3000), E2E_WIDTHS (comma list, default 320,360,375,390,414),
// E2E_HEIGHT (default 720; e.g. 390 with E2E_WIDTHS=844 for a landscape phone),
// E2E_SHOTS=all to keep a screenshot of every state (default: failures plus one width),
// E2E_PACE_MS (default 1500) between states, to stay under the API's per-IP limit of 120 requests a minute.
// Only opens research for symbols that already have a completed run, so it never starts LLM work.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const BASE = (process.env.E2E_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const WIDTHS = (process.env.E2E_WIDTHS ?? "320,360,375,390,414").split(",").map(Number);
const SHOT_WIDTH = process.env.E2E_SHOTS === "all" ? null : 360;
const OUT = new URL("../.screenshots/mobile/", import.meta.url).pathname;
const HEIGHT = Number(process.env.E2E_HEIGHT ?? 720);
const PACE_MS = Number(process.env.E2E_PACE_MS ?? 1500);
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f));

// Runs in the page. Returns problems that make a phone layout unusable or visibly broken.
function audit() {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const name = (el) => {
    const cls = String(el.className?.baseVal ?? el.className ?? "").split(/\s+/).filter(Boolean).slice(0, 4).join(".");
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${text ? ` "${text}"` : ""}`;
  };
  const visible = (el, cs) => cs.display !== "none" && cs.visibility !== "hidden" && !el.closest(".sr-only") && el.getClientRects().length > 0;
  const clippedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== "visible") return true;
    }
    return false;
  };
  const problems = [];
  const add = (kind, detail) => problems.push({ kind, detail });

  const extra = document.documentElement.scrollWidth - vw;
  if (extra > 1) add("page-overflow", `page is ${extra}px wider than the screen`);

  const dialog = document.querySelector("[role=dialog]");
  const scope = dialog ?? document.querySelector("main") ?? document.body;

  for (const el of scope.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    if ((r.right > vw + 1 || r.left < -1) && cs.position !== "fixed" && !clippedByAncestor(el)) add("past-edge", `${name(el)} spans ${Math.round(r.left)}..${Math.round(r.right)}`);

    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "visible" && cs.textOverflow !== "ellipsis" && !/auto|scroll/.test(cs.overflowX))
      add("text-clipped", `${name(el)} needs ${el.scrollWidth}px, has ${el.clientWidth}px`);

    if (el.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select") && parseFloat(cs.fontSize) < 16)
      add("input-zoom", `${name(el)} has font-size ${cs.fontSize}; iOS zooms the page on focus below 16px`);

    if (el.matches("button, a[href], [role=button], [role=tab], [role=switch], summary, input, select") && cs.display !== "inline") {
      // An absolutely positioned pseudo-element with negative insets enlarges the hit area.
      let { width: w, height: h } = r;
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === "none" || ps.position !== "absolute") continue;
        h = Math.max(h, r.height - Math.min(0, parseFloat(ps.top) || 0) - Math.min(0, parseFloat(ps.bottom) || 0));
        w = Math.max(w, r.width - Math.min(0, parseFloat(ps.left) || 0) - Math.min(0, parseFloat(ps.right) || 0));
      }
      if (h < 32 || w < 32) add("tap-target", `${name(el)} is ${Math.round(w)}×${Math.round(h)}px`);
    }

    if (ownText && parseFloat(cs.fontSize) < 10 && /\w/.test(el.textContent)) add("tiny-text", `${name(el)} is ${cs.fontSize}`);

    const text = (el.textContent ?? "").trim();
    if (ownText && cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && el.clientWidth < Math.min(el.scrollWidth, 160) * 0.6)
      add("truncated", `${name(el)} shows ${el.clientWidth}px of ${el.scrollWidth}px`);

    // A short label or control broken over two lines reads as a layout bug.
    if (el.children.length === 0 && text.length > 0 && text.length <= 24 && !/^H[1-3]$/.test(el.tagName) && !el.closest("h1, h2, h3, blockquote, p")) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].filter((q) => q.width > 1).map((q) => Math.round(q.top)));
      const control = !!el.closest("button, a, [role=radio], [role=tab]");
      if (lines.size > 2 || (lines.size > 1 && (control || text.length <= 10))) add("label-wraps", `${name(el)} breaks over ${lines.size} lines`);
    }
  }

  // Overlap: two text-bearing children of a flex row that intersect on the same line.
  for (const row of scope.querySelectorAll("*")) {
    const cs = getComputedStyle(row);
    if (!cs.display.includes("flex") || cs.flexDirection.startsWith("column") || !visible(row, cs)) continue;
    const kids = [...row.children].filter((k) => k.getClientRects().length && (k.textContent ?? "").trim() && getComputedStyle(k).position !== "absolute");
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect();
      const b = kids[i].getBoundingClientRect();
      const sameLine = a.top < b.bottom - 2 && b.top < a.bottom - 2;
      if (sameLine && a.right > b.left + 2 && b.right > a.left + 2) add("overlap", `${name(kids[i - 1])} overlaps ${name(kids[i])}`);
    }
  }

  if (dialog) {
    const r = dialog.getBoundingClientRect();
    if (r.top < 0 || r.bottom > vh + 1 || r.width > vw + 1) add("sheet-bounds", `sheet is ${Math.round(r.width)}×${Math.round(r.height)} at top ${Math.round(r.top)} in a ${vw}×${vh} screen`);
  }

  return problems;
}

// Runs in the page: the end of the content must clear the fixed tab bar once scrolled to the bottom.
function bottomClearance() {
  window.scrollTo(0, document.documentElement.scrollHeight);
  const nav = document.querySelector("nav[aria-label=Primary]");
  if (!nav || getComputedStyle(nav).position !== "fixed") return null;
  const navTop = nav.getBoundingClientRect().top;
  const leaves = [...document.querySelector("main").querySelectorAll("*")].filter((el) => el.children.length === 0 && (el.textContent ?? "").trim() && el.getClientRects().length);
  const last = leaves.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  if (!last) return null;
  const bottom = last.getBoundingClientRect().bottom;
  return bottom > navTop + 1 ? `"${last.textContent.trim().slice(0, 40)}" ends at ${Math.round(bottom)}px, under the tab bar at ${Math.round(navTop)}px` : null;
}

function clickFirst(selector, pattern) {
  const re = pattern ? new RegExp(pattern, "i") : null;
  const el = [...document.querySelectorAll(selector)].find((e) => !re || re.test(e.textContent ?? "") || re.test(e.getAttribute("aria-label") ?? ""));
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
}

const ready = {
  digest: () => document.querySelector("section[aria-labelledby='sec-act'] article, section[aria-labelledby='sec-know'] article") || /caught up/i.test(document.body.textContent),
  research: () => /Research ready/.test(document.body.innerText),
  watch: () => [...document.querySelectorAll("button")].some((b) => /New rule/.test(b.textContent)),
};

const STATES = [
  { id: "today-24h", path: "/", ready: ready.digest },
  { id: "today-7d", path: "/?window=7d", ready: ready.digest },
  {
    id: "today-7d-expanded",
    path: "/?window=7d",
    ready: ready.digest,
    act: () => {
      for (const b of document.querySelectorAll("article button[aria-expanded=false]")) b.click();
      return true;
    },
  },
  {
    id: "today-results-info",
    path: "/?window=7d",
    ready: ready.digest,
    act: async () => {
      for (const b of document.querySelectorAll("article button[aria-expanded=false]")) b.click();
      await new Promise((r) => setTimeout(r, 600));
      const info = document.querySelector("article button[aria-label^='How ']");
      if (!info) return false;
      info.scrollIntoView({ block: "center" });
      info.click();
      return true;
    },
    overlay: true,
  },
  { id: "ask-index", path: "/ask", ready: () => document.querySelector("main input") },
  {
    id: "ask-search",
    path: "/ask",
    ready: () => document.querySelector("main input"),
    act: () => {
      const input = document.querySelector("main input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "bajaj");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
  },
  { id: "ask-cdsl", path: "/ask/CDSL", ready: ready.research },
  { id: "ask-cdsl-citation", path: "/ask/CDSL", ready: ready.research, act: [clickFirst, "#bull_bear button[aria-label^='Source:']"], sheet: true },
  { id: "ask-astral", path: "/ask/ASTRAL", ready: ready.research },
  { id: "ask-astral-ledger-citation", path: "/ask/ASTRAL", ready: ready.research, act: [clickFirst, "#promise_ledger button[aria-label^='Source:']"], sheet: true },
  { id: "ask-astral-ungrounded-info", path: "/ask/ASTRAL", ready: ready.research, act: [clickFirst, "button[aria-label='Why this could not be grounded']"], overlay: true },
  { id: "ask-pageind", path: "/ask/PAGEIND", ready: ready.research },
  { id: "ask-titan", path: "/ask/TITAN", ready: ready.research },
  { id: "watch", path: "/watch", ready: ready.watch },
  { id: "watch-new-rule", path: "/watch", ready: ready.watch, act: [clickFirst, "button", "New rule"], sheet: true },
  { id: "holdings", path: "/holdings", ready: () => document.querySelectorAll("li a[href^='/ask/']").length >= 18 },
  { id: "engine", path: "/engine", ready: () => /Cache hits/i.test(document.body.textContent) },
  { id: "not-found", path: "/no-such-page", ready: () => document.querySelector("main") },
];

const browser = await launch({ port: 9335 });
const { send, evaluate, waitFor, viewport, screenshot } = browser;
const failures = [];
const exceptions = [];
let current = "";
browser.on("Runtime.exceptionThrown", ({ exceptionDetails }) => exceptions.push(`[${current}] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`.slice(0, 300)));

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable")]);
  console.log(`FINN phone layout → ${BASE} at ${WIDTHS.join(", ")}px\n`);
  for (const width of WIDTHS) {
    await viewport(width, HEIGHT, true);
    for (const state of STATES) {
      current = `${state.id}@${width}`;
      await sleep(PACE_MS);
      let problems;
      try {
        await send("Page.navigate", { url: BASE + state.path });
        await waitFor(`${state.path} to load`, () => document.readyState === "complete" && !!document.querySelector("main"));
        await waitFor(`${state.id} content`, state.ready);
        await sleep(700);
        if (state.act) {
          const [fn, ...args] = Array.isArray(state.act) ? state.act : [state.act];
          if (!(await evaluate(fn, ...args))) throw new Error("nothing to open");
          if (state.sheet) await waitFor("sheet", () => document.querySelector("[role=dialog]"), [], 8000);
          await sleep(900);
        }
        problems = await evaluate(audit);
        if (!state.sheet && !state.overlay) {
          const under = await evaluate(bottomClearance);
          if (under) problems.push({ kind: "under-tab-bar", detail: under });
        }
        problems = [...new Map(problems.map((p) => [p.kind + p.detail, p])).values()];
      } catch (e) {
        problems = [{ kind: "error", detail: e.message }];
      }
      if (problems.length) {
        failures.push({ state: state.id, width, problems });
        console.log(`  ✗ ${current}`);
        for (const p of problems.slice(0, 8)) console.log(`      ${p.kind}: ${p.detail}`);
        if (problems.length > 8) console.log(`      … ${problems.length - 8} more`);
      } else console.log(`  ✓ ${current}`);
      if (problems.length || SHOT_WIDTH === null || width === SHOT_WIDTH) {
        const prefix = `${problems.length ? "FAIL-" : ""}${state.id}-${width}`;
        const pages = SHOT_WIDTH === null && !state.sheet && !state.overlay ? 6 : 1;
        for (let i = 0; i < pages; i++) {
          const moved = await evaluate((n, h) => {
            if (document.querySelector("[role=dialog], [role=tooltip]")) return n === 0;
            const y = n * (h - 160);
            if (n > 0 && y >= document.documentElement.scrollHeight - h + (h - 160)) return false;
            window.scrollTo(0, y);
            return true;
          }, i, HEIGHT).catch(() => false);
          if (!moved) break;
          await sleep(250);
          await screenshot(join(OUT, `${prefix}${pages > 1 ? `-${i}` : ""}.png`)).catch(() => {});
        }
      }
    }
  }
} finally {
  await browser.close();
}

if (exceptions.length) {
  console.log(`\nPage exceptions (${exceptions.length}):`);
  for (const e of exceptions.slice(0, 10)) console.log(`  ${e}`);
}
const total = WIDTHS.length * STATES.length;
console.log(`\n${total - failures.length}/${total} states clean. Screenshots in .screenshots/mobile/`);
writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, widths: WIDTHS, failures, exceptions }, null, 2));
process.exit(failures.length || exceptions.length ? 1 : 0);
