import type { Sql } from "../client";

export function watermarksRepo(sql: Sql) {
  return {
    async get(source: string): Promise<Date | null> {
      const [row] = await sql<{ watermark: Date }[]>`SELECT watermark FROM ingestion_watermarks WHERE source = ${source}`;
      return row?.watermark ?? null;
    },

    /** Only ever moves forward, so a late or replayed run can't rewind ingestion. */
    async advance(source: string, to: Date): Promise<Date> {
      const [row] = await sql<{ watermark: Date }[]>`
        INSERT INTO ingestion_watermarks (source, watermark, updated_at) VALUES (${source}, ${to}, now())
        ON CONFLICT (source) DO UPDATE SET
          watermark = GREATEST(ingestion_watermarks.watermark, EXCLUDED.watermark), updated_at = now()
        RETURNING watermark`;
      return row?.watermark ?? to;
    },
  };
}

export type WatermarksRepo = ReturnType<typeof watermarksRepo>;
