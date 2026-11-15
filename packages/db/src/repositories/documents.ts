import type { Sql } from "../client";

export type DocType = "annual_report" | "transcript" | "results_pdf" | "presentation" | "filing";
export type DocStatus = "discovered" | "downloaded" | "extracted" | "chunked" | "embedded" | "ready" | "failed" | "scanned";

export interface DocumentRow {
  id: string;
  symbol: string;
  doc_type: DocType;
  period_label: string;
  period_end: Date | null;
  url: string;
  sha256: string | null;
  pages: number | null;
  text_quality: number | null;
  parser_version: number;
  status: DocStatus;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DiscoveredDocument {
  symbol: string;
  docType: DocType;
  periodLabel: string;
  periodEnd: string | null;
  url: string;
}

/** Human label used in citations, e.g. "Annual Report FY26" or "Q2 FY27 concall". */
export function documentLabel(doc: Pick<DocumentRow, "doc_type" | "period_label">): string {
  switch (doc.doc_type) {
    case "annual_report":
      return `Annual Report ${doc.period_label}`;
    case "transcript":
      return `${doc.period_label} concall`;
    case "presentation":
      return `${doc.period_label} investor presentation`;
    case "results_pdf":
      return `${doc.period_label} results`;
    default:
      return `${doc.period_label} filing`;
  }
}

export function documentsRepo(sql: Sql) {
  return {
    async upsertDiscovered(doc: DiscoveredDocument): Promise<DocumentRow> {
      const [row] = await sql<DocumentRow[]>`
        INSERT INTO documents (symbol, doc_type, period_label, period_end, url)
        VALUES (${doc.symbol}, ${doc.docType}, ${doc.periodLabel}, ${doc.periodEnd}, ${doc.url})
        ON CONFLICT (symbol, url) DO UPDATE
          SET period_label = EXCLUDED.period_label, period_end = EXCLUDED.period_end, updated_at = now()
        RETURNING *`;
      return row!;
    },

    async get(id: string): Promise<DocumentRow | null> {
      const [row] = await sql<DocumentRow[]>`SELECT * FROM documents WHERE id = ${id}`;
      return row ?? null;
    },

    async listBySymbol(symbol: string): Promise<DocumentRow[]> {
      return sql<DocumentRow[]>`
        SELECT * FROM documents WHERE symbol = ${symbol} ORDER BY doc_type, period_end DESC NULLS LAST`;
    },

    async listReady(symbol: string, docTypes?: DocType[]): Promise<DocumentRow[]> {
      return docTypes?.length
        ? sql<DocumentRow[]>`
            SELECT * FROM documents WHERE symbol = ${symbol} AND status = 'ready' AND doc_type = ANY(${docTypes})
            ORDER BY period_end DESC NULLS LAST`
        : sql<DocumentRow[]>`
            SELECT * FROM documents WHERE symbol = ${symbol} AND status = 'ready' ORDER BY period_end DESC NULLS LAST`;
    },

    async setStatus(id: string, status: DocStatus, patch: { error?: string | null; sha256?: string; pages?: number; textQuality?: number } = {}): Promise<void> {
      await sql`
        UPDATE documents SET
          status = ${status},
          error = ${patch.error ?? null},
          sha256 = COALESCE(${patch.sha256 ?? null}, sha256),
          pages = COALESCE(${patch.pages ?? null}::int, pages),
          text_quality = COALESCE(${patch.textQuality ?? null}::real, text_quality),
          updated_at = now()
        WHERE id = ${id}`;
    },

    async savePages(documentId: string, pages: { page: number; text: string }[]): Promise<void> {
      if (pages.length === 0) return;
      await sql.begin(async (tx) => {
        await tx`DELETE FROM document_pages WHERE document_id = ${documentId} AND page > ${pages.length}`;
        for (let i = 0; i < pages.length; i += 200) {
          const batch = pages.slice(i, i + 200).map((p) => ({ document_id: documentId, page: p.page, text: p.text }));
          await tx`
            INSERT INTO document_pages ${tx(batch, "document_id", "page", "text")}
            ON CONFLICT (document_id, page) DO UPDATE SET text = EXCLUDED.text`;
        }
      });
    },

    async pages(documentId: string): Promise<{ page: number; text: string }[]> {
      return sql<{ page: number; text: string }[]>`SELECT page, text FROM document_pages WHERE document_id = ${documentId} ORDER BY page`;
    },

    async companyName(symbol: string): Promise<string | null> {
      const [row] = await sql<{ name: string }[]>`SELECT name FROM companies WHERE symbol = ${symbol}`;
      return row?.name ?? null;
    },

    async pagesFor(refs: { documentId: string; pages: number[] }[]): Promise<{ document_id: string; page: number; text: string }[]> {
      const docIds: string[] = [];
      const pageNos: number[] = [];
      for (const r of refs) for (const p of r.pages) (docIds.push(r.documentId), pageNos.push(p));
      if (docIds.length === 0) return [];
      return sql<{ document_id: string; page: number; text: string }[]>`
        SELECT dp.document_id, dp.page, dp.text
        FROM document_pages dp
        JOIN unnest(${docIds}::uuid[], ${pageNos}::int[]) AS want(document_id, page)
          ON want.document_id = dp.document_id AND want.page = dp.page`;
    },
  };
}

export type DocumentsRepo = ReturnType<typeof documentsRepo>;
