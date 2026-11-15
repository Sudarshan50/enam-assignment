import { once } from "node:events";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { buildContainer } from "./container";
import { createLogger } from "./lib/logger";

const SHUTDOWN_GRACE_MS = 8_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const shutdown = new AbortController();
  const container = await buildContainer(config, { logger, shutdownSignal: shutdown.signal });
  const app = createApp(container.deps);

  const server = app.listen(config.PORT, (err?: Error) => {
    if (err) {
      logger.fatal({ err }, "failed to listen");
      process.exit(1);
    }
    logger.info({ port: config.PORT, env: config.NODE_ENV }, "FINN API listening");
  });
  // Render's proxy keeps connections for 60s; outlive it to avoid 502s on reused sockets.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    shutdown.abort();
    const closed = once(server, "close");
    server.close();
    server.closeIdleConnections();
    const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
    force.unref();
    await closed;
    await container.close();
    logger.info("bye");
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
