import { Router } from "express";
import type { AppDeps } from "../../deps";
import { createRateLimiter } from "../../middleware/rateLimit";
import { healthHandler } from "../health";
import { alertsRouter } from "./alerts";
import { askRouter } from "./ask";
import { companiesRouter } from "./companies";
import { digestRouter } from "./digest";
import { engineRouter } from "./engine";
import { internalJobsRouter } from "./internalJobs";
import { prefsRouter } from "./prefs";
import { pushRouter } from "./push";
import { researchRunsRouter } from "./researchRuns";

export function createV1Router({ config, services, logger, shutdownSignal }: AppDeps): Router {
  const v1 = Router();
  const limits = config.rateLimits;

  v1.use(createRateLimiter("global", limits.global));

  // Health is open. Machine jobs keep their own bearer secret.
  v1.get("/healthz", healthHandler(services.health));
  v1.use("/internal", internalJobsRouter({ jobs: services.jobs, jobsSecret: config.jobsSecret }));

  v1.use(digestRouter(services));
  v1.use(companiesRouter(services));
  v1.use(
    researchRunsRouter({
      research: services.research,
      events: services.researchEvents,
      createLimiter: createRateLimiter("research", limits.research, "Too many research requests. Try again in a minute."),
      sse: config.sse,
      log: logger,
      shutdownSignal,
    }),
  );
  v1.use(
    askRouter({
      ask: services.ask,
      budget: services.llmBudget,
      limiter: createRateLimiter("ask", limits.ask, "You're asking faster than FINN can read. Try again in a minute."),
    }),
  );
  v1.use(alertsRouter({ rules: services.alertRules, alerts: services.alerts }));
  v1.use(
    pushRouter({
      push: services.push,
      testLimiter: createRateLimiter("push-test", limits.pushTest, "Too many test notifications. Try again in a minute."),
    }),
  );
  v1.use(prefsRouter(services.prefs));
  v1.use(engineRouter(services.engine));

  return v1;
}
