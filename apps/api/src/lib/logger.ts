import { pino } from "pino";

/** The subset of pino that services depend on, so tests can pass a silent stub. */
export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
}

export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-finn-access"]',
  'res.headers["set-cookie"]',
];

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    base: { service: "finn-api" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
