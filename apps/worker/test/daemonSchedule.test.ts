import { describe, expect, it } from "vitest";
import { DEFAULT_JOBS, dueJobs, istClock } from "../src/daemon/schedule";

/** Builds a UTC instant from an India-time wall clock. */
const ist = (iso: string) => new Date(Date.parse(`${iso}+05:30`));
const names = (now: Date, last = new Map<string, number>()) => dueJobs(DEFAULT_JOBS, last, now).map((j) => j.name);

describe("daemon schedule", () => {
  it("reads the India-time clock", () => {
    expect(istClock(ist("2026-11-13T18:45:00"))).toEqual({ minutes: 18 * 60 + 45, weekday: 5 });
  });

  it("runs everything that is due on first start", () => {
    expect(names(ist("2026-11-13T18:45:00"))).toEqual(["ingest", "eod", "module-retries"]);
    expect(names(ist("2026-11-13T21:15:00"))).toEqual(["ingest", "eod", "results-backfill", "module-retries"]);
    expect(names(ist("2026-11-15T06:30:00"))).toEqual(["ingest", "master-list", "module-retries"]);
  });

  it("picks up due module retries every 5 minutes, day and night", () => {
    for (const at of [ist("2026-11-13T11:00:00"), ist("2026-11-15T03:00:00")]) {
      expect(names(at, new Map([["module-retries", at.getTime() - 4 * 60_000]]))).not.toContain("module-retries");
      expect(names(at, new Map([["module-retries", at.getTime() - 5 * 60_000]]))).toContain("module-retries");
    }
  });

  it("polls announcements every 10 minutes in the day and hourly overnight", () => {
    const day = ist("2026-11-13T11:00:00");
    const last = new Map([["ingest", day.getTime() - 9 * 60_000]]);
    expect(names(day, last)).not.toContain("ingest");
    last.set("ingest", day.getTime() - 10 * 60_000);
    expect(names(day, last)).toContain("ingest");

    const night = ist("2026-11-14T02:00:00");
    expect(names(night, new Map([["ingest", night.getTime() - 30 * 60_000]]))).not.toContain("ingest");
  });

  it("only fetches the bhavcopy on weekday evenings", () => {
    expect(names(ist("2026-11-13T17:00:00"))).not.toContain("eod");
    expect(names(ist("2026-11-14T19:00:00"))).not.toContain("eod");
    expect(names(ist("2026-11-13T23:45:00"))).not.toContain("eod");
  });
});
