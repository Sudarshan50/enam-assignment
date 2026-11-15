import type { Sql } from "@finn/db";
import type { PrefsRepository, PrefsRow } from "../services/prefsService";
import { num } from "../lib/numbers";
import { json } from "./sql";

export function createPrefsRepository(sql: Sql): PrefsRepository {
  async function ensureRow() {
    await sql`INSERT INTO user_prefs (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  }

  return {
    async get() {
      const select = () => sql<PrefsRow[]>`
        SELECT category_weights AS "categoryWeights", default_window AS "defaultWindow",
               quiet_hours AS "quietHours", updated_at AS "updatedAt"
        FROM user_prefs WHERE id = 1`;
      let [row] = await select();
      if (!row) {
        await ensureRow();
        [row] = await select();
      }
      if (!row) throw new Error("user_prefs row missing");
      return row;
    },

    async update(patch) {
      await ensureRow();
      const weights = patch.categoryWeights;
      const quiet = patch.quietHours;
      const [row] = await sql<PrefsRow[]>`
        UPDATE user_prefs SET
          category_weights = CASE WHEN ${weights !== undefined} THEN category_weights || ${json(sql, weights ?? {})} ELSE category_weights END,
          default_window = COALESCE(${patch.defaultWindow ?? null}, default_window),
          quiet_hours = CASE WHEN ${quiet !== undefined} THEN ${quiet ? json(sql, quiet) : null}::jsonb ELSE quiet_hours END,
          updated_at = now()
        WHERE id = 1
        RETURNING category_weights AS "categoryWeights", default_window AS "defaultWindow",
                  quiet_hours AS "quietHours", updated_at AS "updatedAt"`;
      if (!row) throw new Error("user_prefs row missing");
      return row;
    },

    async updateCategoryWeight(category, next) {
      await ensureRow();
      return sql.begin(async (tx) => {
        const [row] = await tx<{ w: unknown }[]>`SELECT category_weights -> ${category} AS w FROM user_prefs WHERE id = 1 FOR UPDATE`;
        const value = next(num(row?.w));
        await tx`
          UPDATE user_prefs
          SET category_weights = jsonb_set(category_weights, ${[category]}::text[], to_jsonb(${value}::float8)), updated_at = now()
          WHERE id = 1`;
        return value;
      });
    },
  };
}
