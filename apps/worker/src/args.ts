import type { CommandArgs } from "./context";

export interface ParsedArgv {
  command: string | undefined;
  args: CommandArgs;
}

/**
 * Minimal argv parser: `<command> [positionals] --key value --key=value --flag --no-flag`.
 * Keys are kept as written (kebab-case); repeated keys collect into an array.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const args: CommandArgs = { _: [] };
  let command: string | undefined;
  const set = (key: string, value: string | boolean) => {
    const prev = args[key];
    if (prev === undefined) args[key] = value;
    else if (Array.isArray(prev)) prev.push(String(value));
    else args[key] = [String(prev), String(value)];
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith("no-")) {
        set(body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        set(body, next);
        i++;
      } else {
        set(body, true);
      }
      continue;
    }
    if (command === undefined) command = token;
    else args._.push(token);
  }
  return { command, args };
}

export function argString(args: CommandArgs, key: string): string | undefined {
  const v = args[key];
  if (Array.isArray(v)) return v.at(-1);
  if (typeof v === "string") return v.trim() === "" ? undefined : v.trim();
  return undefined;
}

export function requireString(args: CommandArgs, key: string): string {
  const v = argString(args, key);
  if (!v) throw new UsageError(`--${key} is required`);
  return v;
}

export function argFlag(args: CommandArgs, key: string): boolean {
  const v = args[key];
  return v === true || v === "true" || v === "1";
}

export function argInt(args: CommandArgs, key: string, fallback: number): number {
  const v = argString(args, key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${key} must be a positive integer`);
  return n;
}

/** Parses --key YYYY-MM-DD and returns the ISO date string. */
export function argIsoDate(args: CommandArgs, key: string): string | undefined {
  const v = argString(args, key);
  if (v === undefined) return undefined;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN;
  // Date.parse rolls impossible days over (2026-02-30 -> 2026-03-02), so require a round trip.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) throw new UsageError(`--${key} must be YYYY-MM-DD`);
  return v;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
