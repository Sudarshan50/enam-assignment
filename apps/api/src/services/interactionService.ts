import { CategorySchema, USER_WEIGHT_RANGE } from "@finn/shared";
import type { InteractionAction, InteractionResponse } from "../contracts";
import { notFound } from "../http/errors";
import { clamp, round } from "../lib/numbers";
import type { PrefsRepository } from "./prefsService";

export interface InteractionRepository {
  /** Category of the announcement, `undefined` when the announcement does not exist. */
  findCategory(seqId: string): Promise<string | null | undefined>;
  record(input: { seqId: string; action: InteractionAction; category: string | null }): Promise<void>;
}

/** Learns a category weight from one interaction (implemented by @finn/domain/weights/learn). */
export interface WeightLearner {
  adjust(current: number, action: InteractionAction): number;
}

export interface InteractionService {
  record(input: { seqId: string; action: InteractionAction }): Promise<InteractionResponse>;
}

const DEFAULT_WEIGHT = 1;

export function createInteractionService(deps: {
  repo: InteractionRepository;
  prefs: PrefsRepository;
  learner: WeightLearner;
}): InteractionService {
  return {
    async record({ seqId, action }) {
      const rawCategory = await deps.repo.findCategory(seqId);
      if (rawCategory === undefined) throw notFound("Announcement");
      await deps.repo.record({ seqId, action, category: rawCategory });

      const category = CategorySchema.safeParse(rawCategory);
      if (!category.success || category.data === "unclassified") return { ok: true, category: null, weight: null };

      const weight = await deps.prefs.updateCategoryWeight(category.data, (current) =>
        round(clamp(deps.learner.adjust(current ?? DEFAULT_WEIGHT, action), USER_WEIGHT_RANGE.min, USER_WEIGHT_RANGE.max), 3),
      );
      return { ok: true, category: category.data, weight };
    },
  };
}
