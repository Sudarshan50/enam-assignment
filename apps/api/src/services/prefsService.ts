import { type Category, CategorySchema, USER_WEIGHT_RANGE } from "@finn/shared";
import { type Prefs, QuietHoursSchema, type UpdatePrefs, WINDOWS } from "../contracts";
import { clamp, num } from "../lib/numbers";
import { toIsoRequired } from "../lib/time";

export interface PrefsRow {
  categoryWeights: unknown;
  defaultWindow: string;
  quietHours: unknown;
  updatedAt: Date;
}

export interface PrefsRepository {
  get(): Promise<PrefsRow>;
  update(patch: UpdatePrefs): Promise<PrefsRow>;
  /** Atomically reads the current weight (null when unset), applies `next` and stores the result. */
  updateCategoryWeight(category: Category, next: (current: number | null) => number): Promise<number>;
}

export interface PrefsService {
  get(): Promise<Prefs>;
  update(patch: UpdatePrefs): Promise<Prefs>;
}

export function sanitizeWeights(raw: unknown): Prefs["categoryWeights"] {
  const out: Prefs["categoryWeights"] = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const category = CategorySchema.safeParse(key);
    const weight = num(value);
    if (category.success && weight !== null) out[category.data] = clamp(weight, USER_WEIGHT_RANGE.min, USER_WEIGHT_RANGE.max);
  }
  return out;
}

export function toPrefs(row: PrefsRow): Prefs {
  const quiet = QuietHoursSchema.safeParse(row.quietHours);
  const window = (WINDOWS as readonly string[]).includes(row.defaultWindow) ? (row.defaultWindow as Prefs["defaultWindow"]) : "24h";
  return {
    categoryWeights: sanitizeWeights(row.categoryWeights),
    defaultWindow: window,
    quietHours: quiet.success ? quiet.data : null,
    updatedAt: toIsoRequired(row.updatedAt),
  };
}

export function createPrefsService(repo: PrefsRepository): PrefsService {
  return {
    async get() {
      return toPrefs(await repo.get());
    },
    async update(patch) {
      return toPrefs(await repo.update(patch));
    },
  };
}
