import { CardSchema } from "@finn/shared";
import { describe, expect, it } from "vitest";
import { CARD_REGISTRY } from "@/components/cards/registry";
import { dismissalsReducer, parseDismissals, serializeDismissals } from "@/lib/hooks/use-dismissals";

describe("card registry", () => {
  const kinds = CardSchema.options.map((o) => o.shape.kind.value).sort();

  it("has exactly one component per CardSchema kind", () => {
    expect(Object.keys(CARD_REGISTRY).sort()).toEqual(kinds);
  });

  it("maps every kind to a renderable component", () => {
    for (const kind of kinds) expect(typeof CARD_REGISTRY[kind as keyof typeof CARD_REGISTRY]).toBe("function");
  });
});

describe("dismissal state", () => {
  it("dismiss adds and undo removes, without mutating the previous state", () => {
    const empty = new Set<string>();
    const one = dismissalsReducer(empty, { type: "dismiss", id: "a" });
    const two = dismissalsReducer(one, { type: "dismiss", id: "b" });
    expect([...two]).toEqual(["a", "b"]);
    expect(empty.size).toBe(0);
    const undone = dismissalsReducer(two, { type: "undo", id: "a" });
    expect([...undone]).toEqual(["b"]);
    expect([...two]).toEqual(["a", "b"]);
  });

  it("is idempotent for repeat dismiss and for undo of an unknown id", () => {
    const s = dismissalsReducer(new Set(["a"]), { type: "dismiss", id: "a" });
    expect([...s]).toEqual(["a"]);
    expect([...dismissalsReducer(s, { type: "undo", id: "zzz" })]).toEqual(["a"]);
  });

  it("undo then re-dismiss moves the id to the most recent position", () => {
    let s = new Set(["a", "b"]);
    s = dismissalsReducer(s, { type: "undo", id: "a" });
    s = dismissalsReducer(s, { type: "dismiss", id: "a" });
    expect([...s]).toEqual(["b", "a"]);
  });

  it("persists only the most recent ids", () => {
    const ids = new Set(Array.from({ length: 405 }, (_, i) => `id-${i}`));
    const stored = JSON.parse(serializeDismissals(ids)) as string[];
    expect(stored).toHaveLength(400);
    expect(stored[0]).toBe("id-5");
    expect(stored.at(-1)).toBe("id-404");
    expect(JSON.parse(serializeDismissals(new Set(["x", "y"]), 1))).toEqual(["y"]);
  });

  it("reads back stored ids and tolerates junk", () => {
    expect(parseDismissals(serializeDismissals(new Set(["a", "b"])))).toEqual(["a", "b"]);
    expect(parseDismissals(null)).toEqual([]);
    expect(parseDismissals("{not json")).toEqual([]);
    expect(parseDismissals('{"a":1}')).toEqual([]);
    expect(parseDismissals('["a", 2, null, "b"]')).toEqual(["a", "b"]);
  });
});
