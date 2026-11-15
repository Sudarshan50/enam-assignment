import { Router } from "express";
import { JobListSchema, JobNameParamSchema, JobResultSchema } from "../../contracts";
import { notFound } from "../../http/errors";
import { sendJson } from "../../http/respond";
import { requireBearer } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import type { JobRegistry } from "../../services/jobs";

/** Machine-only endpoints guarded by JOBS_SECRET, deliberately outside the demo-token gate. */
export function internalJobsRouter(deps: { jobs: JobRegistry; jobsSecret: string }): Router {
  const router = Router();
  router.use(requireBearer(deps.jobsSecret));

  router.get("/jobs", (_req, res) => {
    sendJson(res, JobListSchema, deps.jobs.list());
  });

  router.post(
    "/jobs/:name",
    validate({ params: JobNameParamSchema }, async ({ params }, req, res) => {
      const job = deps.jobs.get(params.name);
      if (!job) throw notFound(`Job ${params.name}`);
      const result = await job.run();
      req.log?.info({ job: job.name, result }, "internal job finished");
      sendJson(res, JobResultSchema, { job: job.name, ok: true, result });
    }),
  );

  return router;
}
