import type { Health } from "../contracts";

export interface HealthService {
  check(): Promise<Health>;
}

export function createHealthService(deps: { ping: () => Promise<void>; timeoutMs?: number }): HealthService {
  const timeoutMs = deps.timeoutMs ?? 2000;
  return {
    async check() {
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          deps.ping(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("db ping timed out")), timeoutMs);
          }),
        ]);
        return { ok: true, db: "up", latencyMs: Date.now() - started, uptimeS: Math.round(process.uptime()) };
      } catch {
        return { ok: false, db: "down", latencyMs: null, uptimeS: Math.round(process.uptime()) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
