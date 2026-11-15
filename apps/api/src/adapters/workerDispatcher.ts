import type { Logger } from "../lib/logger";

/** Starts the research worker for a queued run. */
export interface WorkerDispatcher {
  readonly kind: "github" | "noop";
  dispatchResearch(input: { symbol: string; runId: string }): Promise<void>;
}

export class DispatchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

export interface GithubDispatcherOptions {
  token: string;
  repo: string;
  workflow: string;
  ref?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** workflow_dispatch needs only Actions: write on a fine-grained token. GitHub answers 204 on success. */
export function createGithubDispatcher(opts: GithubDispatcherOptions): WorkerDispatcher {
  const doFetch = opts.fetch ?? fetch;
  const url = `https://api.github.com/repos/${opts.repo}/actions/workflows/${encodeURIComponent(opts.workflow)}/dispatches`;
  return {
    kind: "github",
    async dispatchResearch({ symbol, runId }) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "finn-api",
          },
          body: JSON.stringify({ ref: opts.ref ?? "main", inputs: { symbol, run_id: runId } }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new DispatchError(`GitHub dispatch request failed: ${(err as Error).message}`, null);
      }
      if (res.status !== 204) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new DispatchError(`GitHub dispatch returned ${res.status}: ${body}`, res.status);
      }
    },
  };
}

/** Used when GITHUB_DISPATCH_TOKEN is missing: the run stays queued for a local `npm run worker`. */
export function createNoopDispatcher(log: Logger): WorkerDispatcher {
  return {
    kind: "noop",
    async dispatchResearch(input) {
      log.warn(input, "GITHUB_DISPATCH_TOKEN not set; research run left queued for a manual worker run");
    },
  };
}
