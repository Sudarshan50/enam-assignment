import { readFileSync, readdirSync } from "node:fs";
import { parseIntegratedXbrl } from "../src/xbrl/parse";
import type { ParsedFiling } from "../src/types";

const dir = new URL("./fixtures/", import.meta.url);

export const FIXTURE_FILES = readdirSync(dir).filter((f) => f.endsWith(".xml")).sort();

export function readXml(name: string): string {
  return readFileSync(new URL(name, dir), "utf8");
}

export function filing(symbol: string, quarter: string): ParsedFiling {
  return parseIntegratedXbrl(readXml(`${symbol}_${quarter}_consolidated.xml`));
}

/** Crore -> rupees, for readable expectations. */
export const cr = (n: number) => Math.round(n * 1e7);
