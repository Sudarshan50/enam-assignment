import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "@finn/sources/http/client";
import { argFlag, argInt, argIsoDate, argString, parseArgv, requireString, UsageError } from "../src/args";
import { isNseHost, throttleHttp } from "../src/http/throttled";
import { addDays, dateRange, istDayStart, istNoon, isWeekend, todayIst } from "../src/time";

describe("parseArgv edge cases", () => {
  it("empty argv has no command", () => {
    expect(parseArgv([])).toEqual({ command: undefined, args: { _: [] } });
  });

  it("a trailing flag and a flag followed by another flag are booleans", () => {
    expect(parseArgv(["ingest", "--once", "--all"])).toEqual({ command: "ingest", args: { _: [], once: true, all: true } });
  });

  it("a flag swallows the next non-flag token as its value", () => {
    expect(parseArgv(["--verbose", "ingest"])).toEqual({ command: undefined, args: { _: [], verbose: "ingest" } });
  });

  it("repeated keys collect into an array, in order, across all forms", () => {
    const { args } = parseArgv(["alerts", "--symbol", "TCS", "--symbol=INFY", "--symbol", "HDFCBANK"]);
    expect(args.symbol).toEqual(["TCS", "INFY", "HDFCBANK"]);
    expect(argString(args, "symbol")).toBe("HDFCBANK");
    expect(parseArgv(["x", "--push", "--no-push"]).args.push).toEqual(["true", "false"]);
  });

  it("--key=value keeps everything after the first '=' (including empty and further '=')", () => {
    const { args } = parseArgv(["x", "--q=a=b", "--empty=", "--dash=-5"]);
    expect(args.q).toBe("a=b");
    expect(args.empty).toBe("");
    expect(argString(args, "empty")).toBeUndefined();
    expect(args.dash).toBe("-5");
  });

  it("a single-dash token is a value, not a flag", () => {
    expect(parseArgv(["x", "--days", "-3"]).args.days).toBe("-3");
    expect(parseArgv(["x", "-v"]).args._).toEqual(["-v"]);
  });

  it("'--' ends option parsing; everything after is positional", () => {
    expect(parseArgv(["research", "--symbol", "TCS", "--", "--not-a-flag", "x"])).toEqual({
      command: "research",
      args: { _: ["--not-a-flag", "x"], symbol: "TCS" },
    });
    expect(parseArgv(["--", "ingest"])).toEqual({ command: undefined, args: { _: ["ingest"] } });
  });

  it("'--no-' alone sets the empty key to false; '--' prefixed key with dashes stays kebab-case", () => {
    expect(parseArgv(["x", "--no-"]).args[""]).toBe(false);
    expect(parseArgv(["x", "--run-id", "abc"]).args["run-id"]).toBe("abc");
  });
});

describe("typed accessors", () => {
  const args = (...argv: string[]) => parseArgv(["cmd", ...argv]).args;

  it("argString trims and ignores booleans", () => {
    expect(argString(args("--s", "  TCS  "), "s")).toBe("TCS");
    expect(argString(args("--s", "   "), "s")).toBeUndefined();
    expect(argString(args("--s"), "s")).toBeUndefined();
    expect(argString(args(), "s")).toBeUndefined();
  });

  it("requireString throws a UsageError naming the flag", () => {
    expect(requireString(args("--symbol", "TCS"), "symbol")).toBe("TCS");
    expect(() => requireString(args(), "symbol")).toThrow(new UsageError("--symbol is required"));
    expect(() => requireString(args("--symbol"), "symbol")).toThrow(UsageError);
  });

  it.each([
    [["--f"], true],
    [["--f", "true"], true],
    [["--f", "1"], true],
    [["--f=true"], true],
    [["--no-f"], false],
    [["--f", "yes"], false],
    [["--f", "0"], false],
    [[], false],
  ])("argFlag(%j) = %s", (argv, expected) => {
    expect(argFlag(args(...argv), "f")).toBe(expected);
  });

  it.each([["0"], ["-1"], ["1.5"], ["abc"], ["1e400"]])("argInt rejects %s", (v) => {
    expect(() => argInt(args("--n", v), "n", 5)).toThrow(new UsageError("--n must be a positive integer"));
  });

  it("argInt accepts positive integers (including 1e3 and padded) and falls back when absent", () => {
    expect(argInt(args("--n", "7"), "n", 5)).toBe(7);
    expect(argInt(args("--n", " 12 "), "n", 5)).toBe(12);
    expect(argInt(args("--n", "1e3"), "n", 5)).toBe(1000);
    expect(argInt(args("--n"), "n", 5)).toBe(5);
    expect(argInt(args("--n", ""), "n", 5)).toBe(5);
  });

  it.each([["2026-02-30"], ["2026-13-01"], ["2026-00-10"], ["2025-02-29"], ["2026-1-5"], ["20261113"], ["2026-11-13T00:00"], ["13-11-2026"]])(
    "argIsoDate rejects %s",
    (v) => {
      expect(() => argIsoDate(args("--date", v), "date")).toThrow(new UsageError("--date must be YYYY-MM-DD"));
    },
  );

  it("argIsoDate accepts real dates including leap days, and is undefined when absent", () => {
    expect(argIsoDate(args("--date", "2028-02-29"), "date")).toBe("2028-02-29");
    expect(argIsoDate(args("--date", " 2026-12-31 "), "date")).toBe("2026-12-31");
    expect(argIsoDate(args(), "date")).toBeUndefined();
  });
});

describe("IST time helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("istDayStart / istNoon map an IST date to UTC instants", () => {
    expect(istDayStart("2026-11-13").toISOString()).toBe("2026-11-12T18:30:00.000Z");
    expect(istNoon("2026-11-13").toISOString()).toBe("2026-11-13T06:30:00.000Z");
  });

  it("addDays crosses month, year and leap boundaries", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-11-13", 0)).toBe("2026-11-13");
  });

  it("todayIst rolls over at 18:30 UTC", () => {
    expect(todayIst(new Date("2026-11-13T18:29:59Z"))).toBe("2026-11-13");
    expect(todayIst(new Date("2026-11-13T18:30:00Z"))).toBe("2026-11-14");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-31T19:00:00Z"));
    expect(todayIst()).toBe("2027-01-01");
  });

  it("isWeekend and dateRange", () => {
    expect(["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"].map(isWeekend)).toEqual([false, true, true, false]);
    expect(dateRange("2026-11-29", "2026-12-02")).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
    expect(dateRange("2026-11-13", "2026-11-13")).toEqual(["2026-11-13"]);
    expect(dateRange("2026-11-14", "2026-11-13")).toEqual([]);
  });
});

describe("throttleHttp", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["www.nseindia.com", true],
    ["nsearchives.nseindia.com", true],
    ["nseindia.in", true],
    ["NSEINDIA.COM", true],
    ["notnseindia.com", false],
    ["nseindia.com.evil.test", false],
    ["query1.finance.yahoo.com", false],
  ])("isNseHost(%s) = %s", (host, expected) => {
    expect(isNseHost(host)).toBe(expected);
  });

  function recordingInner() {
    const calls: { url: string; at: number; kind: string; headers?: Record<string, string> }[] = [];
    const inner: HttpClient = {
      isAllowed: (url) => url.startsWith("https://"),
      async getJson<T>(url: string, headers?: Record<string, string>) {
        calls.push({ url, at: Date.now(), kind: "json", headers });
        return { url } as T;
      },
      async getText(url, headers) {
        calls.push({ url, at: Date.now(), kind: "text", headers });
        return `text:${url}`;
      },
      async getBuffer(url, headers) {
        calls.push({ url, at: Date.now(), kind: "buffer", headers });
        return new Uint8Array([1, 2]);
      },
    };
    return { inner, calls };
  }

  it("spaces NSE calls by the minimum interval, passes other hosts and bad URLs straight through", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    const t0 = Date.now();
    const { inner, calls } = recordingInner();
    const http = throttleHttp(inner, { minIntervalMs: 1000, shouldThrottle: isNseHost });

    const nse = Promise.all([
      http.getJson("https://www.nseindia.com/api/a", { h: "1" }),
      http.getText("https://nsearchives.nseindia.com/b"),
      http.getBuffer("https://www.nseindia.com/c"),
    ]);
    const other = await http.getText("https://query1.finance.yahoo.com/x");
    const bad = await http.getText("not a url");
    expect(other).toBe("text:https://query1.finance.yahoo.com/x");
    expect(bad).toBe("text:not a url");

    await vi.advanceTimersByTimeAsync(2500);
    const [json, text, buf] = await nse;
    expect(json).toEqual({ url: "https://www.nseindia.com/api/a" });
    expect(text).toBe("text:https://nsearchives.nseindia.com/b");
    expect(buf).toEqual(new Uint8Array([1, 2]));

    const nseCalls = calls.filter((c) => c.url.includes("nseindia"));
    expect(nseCalls.map((c) => [c.kind, c.at - t0])).toEqual([
      ["json", 0],
      ["text", 1000],
      ["buffer", 2000],
    ]);
    expect(nseCalls[0]!.headers).toEqual({ h: "1" });
    expect(http.isAllowed("https://x")).toBe(true);
    expect(http.isAllowed("http://x")).toBe(false);
  });
});
