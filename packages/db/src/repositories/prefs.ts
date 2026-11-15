import type postgres from "postgres";
import { CategorySchema, type Category } from "@finn/shared/taxonomy";
import type { Sql } from "../client";

export type CategoryWeights = Partial<Record<Category, number>>;
export type InteractionAction = "pin" | "dismiss" | "open" | "undo";

export interface UserPrefs {
  categoryWeights: CategoryWeights;
  defaultWindow: string;
  updatedAt: Date;
}

function cleanWeights(value: unknown): CategoryWeights {
  const out: CategoryWeights = {};
  if (!value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const cat = CategorySchema.safeParse(k);
    if (cat.success && typeof v === "number" && Number.isFinite(v)) out[cat.data] = v;
  }
  return out;
}

export function prefsRepo(sql: Sql) {
  return {
    async get(): Promise<UserPrefs> {
      const [row] = await sql<{ category_weights: unknown; default_window: string; updated_at: Date }[]>`
        SELECT category_weights, default_window, updated_at FROM user_prefs WHERE id = 1`;
      return {
        categoryWeights: cleanWeights(row?.category_weights),
        defaultWindow: row?.default_window ?? "24h",
        updatedAt: row?.updated_at ?? new Date(0),
      };
    },

    async getCategoryWeights(): Promise<CategoryWeights> {
      return (await this.get()).categoryWeights;
    },

    async setCategoryWeight(category: Category, weight: number): Promise<void> {
      const patch = { [category]: weight } as postgres.JSONValue;
      await sql`
        INSERT INTO user_prefs (id, category_weights) VALUES (1, ${sql.json(patch)})
        ON CONFLICT (id) DO UPDATE SET category_weights = user_prefs.category_weights || EXCLUDED.category_weights, updated_at = now()`;
    },

    async setDefaultWindow(window: string): Promise<void> {
      await sql`UPDATE user_prefs SET default_window = ${window}, updated_at = now() WHERE id = 1`;
    },

    async recordInteraction(input: { seqId: string | null; action: InteractionAction; category: Category | null }): Promise<void> {
      await sql`INSERT INTO interactions (seq_id, action, category) VALUES (${input.seqId}, ${input.action}, ${input.category})`;
    },

    /** Dismissals per category in the trailing window, for the "Mute dividends?" suggestion. */
    async dismissCounts(sinceDays = 30): Promise<Partial<Record<Category, number>>> {
      const rows = await sql<{ category: string; n: number }[]>`
        SELECT category, count(*)::int AS n FROM interactions
        WHERE action = 'dismiss' AND category IS NOT NULL AND created_at > now() - make_interval(days => ${sinceDays})
        GROUP BY category`;
      const out: Partial<Record<Category, number>> = {};
      for (const r of rows) {
        const cat = CategorySchema.safeParse(r.category);
        if (cat.success) out[cat.data] = r.n;
      }
      return out;
    },
  };
}

export type PrefsRepo = ReturnType<typeof prefsRepo>;
