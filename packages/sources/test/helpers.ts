import { readFileSync } from "node:fs";
import { HttpError, type HttpClient } from "../src/http/client";

export function fixturePath(name: string): URL {
  return new URL(`./fixtures/${name}`, import.meta.url);
}

export function readFixture(name: string): string {
  return readFileSync(fixturePath(name), "utf8");
}

export function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)));
}

type Route = string | Uint8Array | unknown;

/** In-memory HttpClient: routes match by exact URL; unknown URLs answer 404. Records every call. */
export function fakeHttp(routes: Record<string, Route>): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  const lookup = (url: string) => {
    calls.push(url);
    if (!(url in routes)) throw new HttpError(`HTTP 404 for ${url}`, url, 404);
    return routes[url];
  };
  return {
    calls,
    isAllowed: () => true,
    async getJson<T>(url: string) {
      const body = lookup(url);
      return (typeof body === "string" ? JSON.parse(body) : body) as T;
    },
    async getText(url: string) {
      const body = lookup(url);
      return typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
    },
    async getBuffer(url: string) {
      const body = lookup(url);
      return typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array);
    },
  };
}
