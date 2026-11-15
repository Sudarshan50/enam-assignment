import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { AppDeps } from "./deps";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { requestId } from "./middleware/requestId";
import { healthHandler } from "./routes/health";
import { createV1Router } from "./routes/v1";

/** Builds the HTTP app from injected dependencies only (no module state), so tests can pass fakes. */
export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.locals.responseValidation = config.responseValidation;

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === "/healthz" },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Last-Event-ID", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id", "RateLimit", "RateLimit-Policy", "Retry-After"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: config.jsonLimit }));
  app.use(cookieParser());

  app.get("/healthz", healthHandler(deps.services.health));
  app.use("/api/v1", createV1Router(deps));

  app.use(notFoundHandler());
  app.use(errorHandler(logger, !config.isProduction));
  return app;
}
