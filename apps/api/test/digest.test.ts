import request from "supertest";
import { describe, expect, it } from "vitest";
import { DigestResponseSchema } from "@finn/shared";
import { HttpError } from "../src/http/errors";
import type { AnnouncementRow } from "../src/services/announcementMapper";
import { createDigestService, resolveWindow } from "../src/services/digestService";
import { type SourceHealthRow, createSourceHealthService, isStale } from "../src/services/sourceHealthService";
import { auth, buildTestApp } from "./helpers";

// Friday 13 Nov 2026, 14:00 IST (a weekday inside polling hours).
const NOW = new Date("2026-11-13T08:30:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function row(partial: Partial<AnnouncementRow> & Pick<AnnouncementRow, "seqId">): AnnouncementRow {
  return {
    symbol: "TCS",
    companyName: "Tata Consultancy Services Ltd",
    headline: `Headline ${partial.seqId}`,
    oneLiner: null,
    publishedAt: minutesAgo(60),
    pdfUrl: null,
    category: "results",
    tier: "act",
    score: 80,
    reasonCodes: [],
    card: null,
    parentSeqId: null,
    status: "ready",
    read: false,
    dismissed: false,
    ...partial,
  };
}

const freshHealth: SourceHealthRow = {
  source: "nse_announcements",
  lastSuccessAt: minutesAgo(10),
  lastAttemptAt: minutesAgo(10),
  consecutiveFailures: 0,
  lastError: null,
};

function service(rows: AnnouncementRow[], health: SourceHealthRow[] = [freshHealth]) {
  return createDigestService({
    repo: { listWindow: async () => rows },
    sourceHealth: createSourceHealthService({ list: async () => health }, () => NOW),
    now: () => NOW,
  });
}

const genericCard = { kind: "generic", oneLiner: "x" };

describe("digest service", () => {
  const rows = [
    row({ seqId: "A1", score: 84, tier: "act", read: true, card: genericCard }),
    row({ seqId: "A1-ad", parentSeqId: "A1", status: "enriched", tier: "noise", publishedAt: minutesAgo(30) }),
    row({ seqId: "A1-xbrl", parentSeqId: "A1", publishedAt: minutesAgo(50) }),
    row({ seqId: "A2", score: 72, tier: "act", read: true, symbol: "ITC", card: { kind: "results", bogus: true } }),
    row({ seqId: "K1", score: 40, tier: "know", category: "dividend" }),
    row({ seqId: "K2", score: 55, tier: "know", category: "credit_rating" }),
    row({ seqId: "N1", score: 20, tier: null, category: "made_up_category" }),
    row({ seqId: "D1", score: 90, tier: "act", dismissed: true }),
  ];

  it("splits cluster heads into tiers, sorted by score, with children linked oldest first", async () => {
    const digest = await service(rows).getDigest({ window: "24h" });
    expect(DigestResponseSchema.safeParse(digest).success).toBe(true);
    expect(digest.act.map((i) => i.id)).toEqual(["A1", "A2"]);
    expect(digest.know.map((i) => i.id)).toEqual(["K2", "K1"]);
    expect(digest.noise.map((i) => i.id)).toEqual(["N1"]);
    expect(digest.counts).toEqual({ act: 2, know: 2, noise: 1 });
    expect(digest.act[0]!.linked.map((l) => l.seqId)).toEqual(["A1-xbrl", "A1-ad"]);
  });

  it("drops dismissed items and never treats children as heads", async () => {
    const digest = await service(rows).getDigest({});
    const ids = [...digest.act, ...digest.know, ...digest.noise].map((i) => i.id);
    expect(ids).not.toContain("D1");
    expect(ids).not.toContain("A1-ad");
  });

  it("degrades bad stored data instead of failing", async () => {
    const digest = await service(rows).getDigest({});
    expect(digest.act.find((i) => i.id === "A1")!.card).toEqual(genericCard);
    expect(digest.act.find((i) => i.id === "A2")!.card).toBeNull();
    const n1 = digest.noise[0]!;
    expect(n1.category).toBe("unclassified");
    expect(n1.tier).toBe("noise");
  });

  it("is caught up only when every act item is read and ingestion is fresh", async () => {
    expect((await service(rows).getDigest({})).caughtUp).toBe(true);
    const unread = [...rows, row({ seqId: "A3", score: 75, read: false })];
    expect((await service(unread).getDigest({})).caughtUp).toBe(false);
    const stale = { ...freshHealth, lastSuccessAt: minutesAgo(90) };
    const staleDigest = await service(rows, [stale]).getDigest({});
    expect(staleDigest.caughtUp).toBe(false);
    expect(staleDigest.sourceHealth[0]!.stale).toBe(true);
    expect((await service(rows, []).getDigest({})).caughtUp).toBe(false);
  });

  it("reports asOf from the announcements source", async () => {
    const digest = await service(rows, [freshHealth, { ...freshHealth, source: "nse_bhavcopy", lastSuccessAt: minutesAgo(1) }]).getDigest({});
    expect(digest.asOf).toBe(minutesAgo(10).toISOString());
  });
});

describe("resolveWindow", () => {
  it("maps named windows back from now", () => {
    const { from, to } = resolveWindow({ window: "3d" }, NOW);
    expect(to).toEqual(NOW);
    expect(NOW.getTime() - from.getTime()).toBe(3 * 24 * 3600_000);
  });

  it("accepts explicit from/to and rejects inverted or huge ranges", () => {
    const w = resolveWindow({ from: "2026-11-10T00:00:00Z", to: "2026-11-12T00:00:00Z" }, NOW);
    expect(w.from.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(() => resolveWindow({ from: "2026-11-12T00:00:00Z", to: "2026-11-10T00:00:00Z" }, NOW)).toThrow(HttpError);
    expect(() => resolveWindow({ from: "2026-01-01T00:00:00Z", to: "2026-11-10T00:00:00Z" }, NOW)).toThrow(/31 days/);
  });
});

describe("source staleness", () => {
  const ist = (iso: string) => new Date(`${iso}+05:30`);
  const ann = (last: string | null, failures = 0) => ({
    source: "nse_announcements",
    lastSuccessAt: last ? ist(last) : null,
    consecutiveFailures: failures,
  });

  it("flags announcements older than 45 minutes during weekday polling hours", () => {
    expect(isStale(ann("2026-11-13T13:30:00"), ist("2026-11-13T14:00:00"))).toBe(false);
    expect(isStale(ann("2026-11-13T13:00:00"), ist("2026-11-13T14:00:00"))).toBe(true);
  });

  it("does not flag nights and weekends after the last poll succeeded", () => {
    expect(isStale(ann("2026-11-13T21:50:00"), ist("2026-11-14T12:00:00"))).toBe(false); // Saturday
    expect(isStale(ann("2026-11-13T21:50:00"), ist("2026-11-16T08:00:00"))).toBe(false); // Monday pre-open
    expect(isStale(ann("2026-11-13T21:50:00"), ist("2026-11-16T10:00:00"))).toBe(true); // Monday, no poll yet
    expect(isStale(ann("2026-11-13T18:00:00"), ist("2026-11-14T12:00:00"))).toBe(true); // missed Friday evening
  });

  it("flags never-succeeded sources and repeated failures", () => {
    expect(isStale(ann(null), ist("2026-11-13T14:00:00"))).toBe(true);
    expect(isStale(ann("2026-11-13T13:50:00", 3), ist("2026-11-13T14:00:00"))).toBe(true);
  });

  it("expects end-of-day prices after each weekday evening", () => {
    const bhav = (last: string) => ({ source: "nse_bhavcopy", lastSuccessAt: ist(last), consecutiveFailures: 0 });
    expect(isStale(bhav("2026-11-16T19:00:00"), ist("2026-11-17T10:00:00"))).toBe(false); // Tue morning, Mon done
    expect(isStale(bhav("2026-11-16T19:00:00"), ist("2026-11-17T23:00:00"))).toBe(true); // Tue night, Tue missing
    expect(isStale(bhav("2026-11-13T19:00:00"), ist("2026-11-15T12:00:00"))).toBe(false); // Sunday
  });
});

describe("GET /api/v1/digest", () => {
  it("returns the shared DigestResponse shape", async () => {
    const app = buildTestApp({ digest: service([row({ seqId: "A1" })]) });
    const res = await request(app).get("/api/v1/digest?window=7d").set(auth);
    expect(res.status).toBe(200);
    expect(DigestResponseSchema.parse(res.body).act[0]!.id).toBe("A1");
  });

  it("returns 400 for an inverted explicit range", async () => {
    const app = buildTestApp({ digest: service([]) });
    const res = await request(app)
      .get("/api/v1/digest")
      .query({ from: "2026-11-12T00:00:00Z", to: "2026-11-10T00:00:00Z" })
      .set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });
});
