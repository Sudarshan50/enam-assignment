import { Router } from "express";
import { z } from "zod";
import { HoldingSchema } from "@finn/shared";
import {
  CompanyResearchSchema,
  CompanySearchQuerySchema,
  CompanySearchResultSchema,
  FinancialsResponseSchema,
  SymbolParamSchema,
} from "../../contracts";
import { sendJson } from "../../http/respond";
import { validate } from "../../middleware/validate";
import type { CompanyService } from "../../services/companyService";
import type { HoldingsService } from "../../services/holdingsService";
import type { ResearchService } from "../../services/researchService";

export function companiesRouter(deps: { holdings: HoldingsService; companies: CompanyService; research: ResearchService }): Router {
  const router = Router();

  router.get("/holdings", async (_req, res) => {
    sendJson(res, z.array(HoldingSchema), await deps.holdings.list());
  });

  router.get(
    "/companies/search",
    validate({ query: CompanySearchQuerySchema }, async ({ query }, _req, res) => {
      sendJson(res, z.array(CompanySearchResultSchema), await deps.companies.search(query.q));
    }),
  );

  router.get(
    "/companies/:symbol/financials",
    validate({ params: SymbolParamSchema }, async ({ params }, _req, res) => {
      sendJson(res, FinancialsResponseSchema, await deps.companies.financials(params.symbol));
    }),
  );

  router.get(
    "/companies/:symbol/research",
    validate({ params: SymbolParamSchema }, async ({ params }, _req, res) => {
      sendJson(res, CompanyResearchSchema, await deps.research.companyResearch(params.symbol));
    }),
  );

  return router;
}
