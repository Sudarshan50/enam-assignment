import { XMLParser } from "fast-xml-parser";
import type { XbrlContext, XbrlFact } from "../types";

export class XbrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XbrlParseError";
  }
}

export const CORE_CONTEXTS: readonly XbrlContext[] = ["OneD", "FourD", "OneI", "PY_I"];

export interface ContextPeriod {
  start: string | null;
  end: string | null;
  instant: string | null;
}

/** Raw read of an instance document, restricted to the four undimensioned core contexts. */
export interface XbrlDocument {
  contexts: Partial<Record<XbrlContext, ContextPeriod>>;
  numeric: XbrlFact[];
  /** Non-numeric facts (dates, labels, flags) by context then concept. */
  text: Partial<Record<XbrlContext, Record<string, string>>>;
}

type XmlNode = Record<string, unknown>;

const NON_FACT_KEYS = new Set(["schemaRef", "context", "unit", "roleRef", "arcroleRef", "footnoteLink"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (_name, _jpath, _isLeaf, isAttribute) => !isAttribute,
});

export function readXbrlDocument(xml: string): XbrlDocument {
  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (err) {
    throw new XbrlParseError(`Malformed XBRL: ${(err as Error).message}`);
  }
  const root = first(doc.xbrl);
  if (!root) throw new XbrlParseError("Not an XBRL instance: missing <xbrl> root");

  const contexts = readContexts(nodes(root.context));
  const numeric: XbrlFact[] = [];
  const text: XbrlDocument["text"] = {};
  const seen = new Set<string>();

  for (const [concept, value] of Object.entries(root)) {
    if (concept.startsWith("@_") || NON_FACT_KEYS.has(concept)) continue;
    for (const node of nodes(value)) {
      const context = node["@_contextRef"] as XbrlContext | undefined;
      if (!context || !contexts[context] || node["@_nil"] === "true") continue;
      const raw = textOf(node);
      const unit = typeof node["@_unitRef"] === "string" ? node["@_unitRef"] : null;
      if (unit === null) {
        (text[context] ??= {})[concept] ??= raw;
        continue;
      }
      const key = `${context}|${concept}`;
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n) || seen.has(key)) continue;
      seen.add(key);
      numeric.push({ concept, context, value: n, unit, decimals: typeof node["@_decimals"] === "string" ? node["@_decimals"] : null });
    }
  }
  return { contexts, numeric, text };
}

/** Segment and line-item contexts carry dimensions; only the plain core contexts are kept. */
function readContexts(list: XmlNode[]): XbrlDocument["contexts"] {
  const out: XbrlDocument["contexts"] = {};
  for (const ctx of list) {
    const id = ctx["@_id"];
    if (typeof id !== "string" || !(CORE_CONTEXTS as readonly string[]).includes(id)) continue;
    const entity = first(ctx.entity);
    if (ctx.scenario || entity?.segment) continue;
    const period = first(ctx.period);
    out[id as XbrlContext] = {
      start: textOf(first(period?.startDate)) || null,
      end: textOf(first(period?.endDate)) || null,
      instant: textOf(first(period?.instant)) || null,
    };
  }
  return out;
}

function nodes(value: unknown): XmlNode[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "object" && v !== null ? (v as XmlNode) : { "#text": String(v) }));
}

function first(value: unknown): XmlNode | undefined {
  return nodes(value)[0];
}

function textOf(node: XmlNode | undefined): string {
  if (!node) return "";
  const t = node["#text"];
  if (Array.isArray(t)) return t.map(String).join("").trim();
  return t == null ? "" : String(t).trim();
}
