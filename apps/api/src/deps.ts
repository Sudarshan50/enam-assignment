import type { pino } from "pino";
import type { ResponseValidationMode } from "./http/respond";
import type { LlmBudget } from "./middleware/budget";
import type { RateLimitRule } from "./middleware/rateLimit";
import type { AlertRuleService, AlertService } from "./services/alertRuleService";
import type { AnnouncementService } from "./services/announcementService";
import type { AskService } from "./services/askService";
import type { CompanyService } from "./services/companyService";
import type { DigestService } from "./services/digestService";
import type { EngineService } from "./services/engineService";
import type { HealthService } from "./services/healthService";
import type { HoldingsService } from "./services/holdingsService";
import type { InteractionService } from "./services/interactionService";
import type { JobRegistry } from "./services/jobs";
import type { PrefsService } from "./services/prefsService";
import type { PushService } from "./services/pushService";
import type { ResearchEventsSource, SseOptions } from "./services/researchEventStream";
import type { ResearchService } from "./services/researchService";

export interface AppConfig {
  jobsSecret: string;
  corsOrigins: string[];
  isProduction: boolean;
  trustProxy: number | boolean | string;
  jsonLimit: string;
  rateLimits: { global: RateLimitRule; ask: RateLimitRule; research: RateLimitRule; pushTest: RateLimitRule };
  responseValidation: ResponseValidationMode;
  sse: SseOptions;
}

export interface AppServices {
  health: HealthService;
  digest: DigestService;
  announcements: AnnouncementService;
  interactions: InteractionService;
  holdings: HoldingsService;
  companies: CompanyService;
  research: ResearchService;
  researchEvents: ResearchEventsSource;
  ask: AskService;
  llmBudget: LlmBudget;
  alertRules: AlertRuleService;
  alerts: AlertService;
  push: PushService;
  prefs: PrefsService;
  engine: EngineService;
  jobs: JobRegistry;
}

export interface AppDeps {
  config: AppConfig;
  /** pino-http needs a real pino instance; tests pass `pino({ level: "silent" })`. */
  logger: pino.Logger;
  services: AppServices;
  /** Aborted on shutdown so long-lived SSE streams end promptly. */
  shutdownSignal?: AbortSignal;
}
