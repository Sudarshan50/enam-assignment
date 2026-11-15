import { type Sql, closeDb, getDb } from "@finn/db";
import type { pino } from "pino";
import { loadAskEngine, loadRuleParser, loadWeightLearner } from "./adapters/agentModules";
import { createWebPushSender } from "./adapters/webPush";
import { createGithubDispatcher, createNoopDispatcher } from "./adapters/workerDispatcher";
import { type Config, toAppConfig } from "./config";
import type { AppDeps } from "./deps";
import { createAlertsRepository } from "./repositories/alerts";
import { createAnnouncementsRepository } from "./repositories/announcements";
import { createCompaniesRepository } from "./repositories/companies";
import { createEngineRepository, createMaintenanceRepository } from "./repositories/engine";
import { createHoldingsRepository } from "./repositories/holdings";
import { createPrefsRepository } from "./repositories/prefs";
import { createPushRepository } from "./repositories/push";
import { createResearchRepository } from "./repositories/research";
import { createSourceHealthRepository } from "./repositories/sourceHealth";
import { createAlertRuleService, createAlertService } from "./services/alertRuleService";
import { createAnnouncementService } from "./services/announcementService";
import { createAskService } from "./services/askService";
import { createCompanyService } from "./services/companyService";
import { createDigestService } from "./services/digestService";
import { createEngineService, createLlmBudget } from "./services/engineService";
import { createHealthService } from "./services/healthService";
import { createHoldingsService } from "./services/holdingsService";
import { createInteractionService } from "./services/interactionService";
import { JobRegistry } from "./services/jobs";
import { createPrefsService } from "./services/prefsService";
import { createPushService } from "./services/pushService";
import { createResearchService } from "./services/researchService";
import { createSourceHealthService } from "./services/sourceHealthService";

export interface Container {
  deps: AppDeps;
  close(): Promise<void>;
}

/** Composition root: the only place that knows concrete repositories, adapters and agent packages. */
export async function buildContainer(
  config: Config,
  opts: { logger: pino.Logger; shutdownSignal?: AbortSignal; sql?: Sql },
): Promise<Container> {
  const { logger } = opts;
  const sql = opts.sql ?? getDb({ url: config.DATABASE_URL, max: config.DB_POOL_MAX });

  const announcementsRepo = createAnnouncementsRepository(sql);
  const prefsRepo = createPrefsRepository(sql);
  const researchRepo = createResearchRepository(sql);
  const alertsRepo = createAlertsRepository(sql);
  const engineRepo = createEngineRepository(sql);
  const maintenance = createMaintenanceRepository(sql);

  const dispatcher = config.GITHUB_DISPATCH_TOKEN
    ? createGithubDispatcher({
        token: config.GITHUB_DISPATCH_TOKEN,
        repo: config.GITHUB_REPO,
        workflow: config.GITHUB_RESEARCH_WORKFLOW,
        ref: config.GITHUB_REF,
      })
    : createNoopDispatcher(logger);
  const pushSender =
    config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
      ? createWebPushSender({ subject: config.VAPID_SUBJECT, publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY })
      : null;

  const [ruleParser, weightLearner, askEngine] = await Promise.all([
    loadRuleParser(logger),
    loadWeightLearner(logger),
    loadAskEngine(config, sql, logger),
  ]);

  const sourceHealth = createSourceHealthService(createSourceHealthRepository(sql));
  const llmBudget = createLlmBudget({ repo: engineRepo, dailyBudget: config.LLM_DAILY_CALL_BUDGET });
  const research = createResearchService({ repo: researchRepo, dispatcher, runsPerDay: config.RESEARCH_RUNS_PER_DAY, log: logger });

  const jobs = new JobRegistry([
    {
      name: "dispatch-research",
      description: "Re-dispatch research runs queued for over 10 minutes; fail them after 3 attempts",
      run: () => research.redispatchStale(),
    },
    {
      name: "prune-llm-cache",
      description: "Delete LLM cache entries unused for 30 days",
      run: async () => ({ deleted: await maintenance.pruneLlmCache(30) }),
    },
  ]);

  const deps: AppDeps = {
    config: toAppConfig(config),
    logger,
    shutdownSignal: opts.shutdownSignal,
    services: {
      health: createHealthService({ ping: () => maintenance.ping() }),
      digest: createDigestService({ repo: announcementsRepo, sourceHealth, log: logger }),
      announcements: createAnnouncementService({ repo: announcementsRepo, log: logger }),
      interactions: createInteractionService({ repo: announcementsRepo, prefs: prefsRepo, learner: weightLearner }),
      holdings: createHoldingsService(createHoldingsRepository(sql)),
      companies: createCompanyService(createCompaniesRepository(sql)),
      research,
      researchEvents: researchRepo,
      ask: createAskService({ engine: askEngine, companyExists: async (s) => (await researchRepo.findCompany(s)) !== null }),
      llmBudget,
      alertRules: createAlertRuleService({ repo: alertsRepo, parser: ruleParser, log: logger }),
      alerts: createAlertService(alertsRepo),
      push: createPushService({ repo: createPushRepository(sql), sender: pushSender, vapidPublicKey: config.VAPID_PUBLIC_KEY ?? null, log: logger }),
      prefs: createPrefsService(prefsRepo),
      engine: createEngineService({ repo: engineRepo, sourceHealth, budget: llmBudget }),
      jobs,
    },
  };

  logger.info(
    { dispatcher: dispatcher.kind, push: Boolean(pushSender), responseValidation: deps.config.responseValidation },
    "container ready",
  );

  return {
    deps,
    async close() {
      if (!opts.sql) await closeDb();
    },
  };
}
