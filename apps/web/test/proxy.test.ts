import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const ORIGIN = "http://localhost:3000";
const SECRET = "s3cret-demo-token-0123456789";

/** proxy.ts reads NEXT_PUBLIC_USE_MOCKS at module load, so each mode needs a fresh import. */
async function loadProxy(env: { mocks?: boolean; token?: string; nodeEnv?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", env.mocks ? "1" : "");
  vi.stubEnv("DEMO_ACCESS_TOKEN", env.token ?? "");
  if (env.nodeEnv) vi.stubEnv("NODE_ENV", env.nodeEnv);
  return (await import("@/proxy")).proxy;
}

function req(path: string, cookie?: string) {
  return new NextRequest(`${ORIGIN}${path}`, cookie ? { headers: { cookie: `finn_access=${cookie}` } } : undefined);
}

const rewrittenTo = (res: Response) => res.headers.get("x-middleware-rewrite");
const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("proxy (production token)", () => {
  it("?k with the right token sets an httpOnly cookie and redirects to the clean URL", async () => {
    const proxy = await loadProxy({ token: SECRET });
    const res = proxy(req(`/holdings?k=${SECRET}&window=3d`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/holdings?window=3d`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`finn_access=${SECRET}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("marks the cookie Secure in production", async () => {
    const proxy = await loadProxy({ token: SECRET, nodeEnv: "production" });
    expect(proxy(req(`/?k=${SECRET}`)).headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("passes through with a valid cookie", async () => {
    const proxy = await loadProxy({ token: SECRET });
    expect(passedThrough(proxy(req("/watch", SECRET)))).toBe(true);
  });

  it("rewrites pages to /locked without a cookie, keeping the URL", async () => {
    const proxy = await loadProxy({ token: SECRET });
    const res = proxy(req("/ask/CDSL"));
    expect(rewrittenTo(res)).toBe(`${ORIGIN}/locked`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers API calls without a cookie with 401 JSON", async () => {
    const proxy = await loadProxy({ token: SECRET });
    const res = proxy(req("/api/v1/digest"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "locked" });
  });

  it.each([
    ["a wrong token of the same length", SECRET.replace(/.$/, "X")],
    ["a prefix of the token", SECRET.slice(0, -1)],
    ["the token plus a suffix", `${SECRET}x`],
    ["an empty token", ""],
    ["whitespace", "   "],
  ])("rejects %s from ?k and from the cookie", async (_label, bad) => {
    const proxy = await loadProxy({ token: SECRET });
    const fromLink = proxy(req(`/?k=${encodeURIComponent(bad)}`));
    expect(fromLink.status).not.toBe(307);
    expect(rewrittenTo(fromLink)).toBe(`${ORIGIN}/locked`);
    if (bad.trim()) expect(rewrittenTo(proxy(req("/", bad)))).toBe(`${ORIGIN}/locked`);
  });

  it("rejects everything when DEMO_ACCESS_TOKEN is unset", async () => {
    const proxy = await loadProxy({});
    expect(rewrittenTo(proxy(req("/?k=anything")))).toBe(`${ORIGIN}/locked`);
    expect(rewrittenTo(proxy(req("/", "anything")))).toBe(`${ORIGIN}/locked`);
  });

  it("rejects absurdly long tokens", async () => {
    const long = "x".repeat(300);
    const proxy = await loadProxy({ token: long });
    expect(rewrittenTo(proxy(req(`/?k=${long}`)))).toBe(`${ORIGIN}/locked`);
  });

  it("a bad ?k does not discard an existing valid cookie", async () => {
    const proxy = await loadProxy({ token: SECRET });
    expect(passedThrough(proxy(req("/?k=wrong", SECRET)))).toBe(true);
  });
});

describe("proxy (mock mode)", () => {
  it("accepts any non-empty token", async () => {
    const proxy = await loadProxy({ mocks: true });
    const res = proxy(req("/?k=dev"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(passedThrough(proxy(req("/engine", "dev")))).toBe(true);
  });

  it("still locks without a token", async () => {
    const proxy = await loadProxy({ mocks: true });
    expect(rewrittenTo(proxy(req("/")))).toBe(`${ORIGIN}/locked`);
    expect(rewrittenTo(proxy(req("/?k=")))).toBe(`${ORIGIN}/locked`);
  });
});
