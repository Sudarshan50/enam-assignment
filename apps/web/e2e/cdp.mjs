// Minimal headless Chrome driver over the DevTools protocol, shared by the e2e scripts.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port, headful = !!process.env.E2E_HEADFUL } = {}) {
  const binary = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profile = mkdtempSync(join(tmpdir(), "finn-e2e-"));
  const chrome = spawn(
    binary,
    [
      ...(headful ? [] : ["--headless=new"]),
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let wsUrl;
  for (let i = 0; i < 75 && !wsUrl; i++) {
    await sleep(200);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      wsUrl = pages.find((p) => p.type === "page")?.webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) {
    chrome.kill();
    throw new Error("Chrome did not expose a page target");
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);

  // DOM nodes can't be returned by value; predicates may return one to mean "found".
  async function evaluate(fn, ...args) {
    const expression = `(async () => { const v = await (${fn.toString()})(...${JSON.stringify(args)}); return v instanceof Node ? true : v; })()`;
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
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

  async function viewport(width, height, mobile) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  }

  async function screenshot(path) {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  }

  async function pressKey(key, code, keyCode) {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
  }

  async function close() {
    try {
      ws.close();
    } catch {}
    const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {}
  }

  return { send, on, evaluate, waitFor, viewport, screenshot, pressKey, close };
}
