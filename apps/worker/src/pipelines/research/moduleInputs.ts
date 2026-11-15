import { tablesFromRows, type HistoryTables } from "@finn/ai/financials/history";
import type { ModuleDocument } from "@finn/ai/modules/types";
import { documentLabel, documentsRepo } from "@finn/db/repositories/documents";
import { historyRepo } from "@finn/db/repositories/history";
import type { WorkerContext } from "../../context";

function iso(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** The ready documents and history tables research modules read for a symbol. */
export async function loadModuleInputs(ctx: Pick<WorkerContext, "sql">, symbol: string): Promise<{ documents: ModuleDocument[]; history: HistoryTables }> {
  const ready = await documentsRepo(ctx.sql).listReady(symbol, ["annual_report", "transcript"]);
  const documents: ModuleDocument[] = ready.map((d) => ({
    id: d.id,
    docType: d.doc_type,
    label: documentLabel(d),
    periodLabel: d.period_label,
    periodEnd: iso(d.period_end),
    url: d.url,
    sha256: d.sha256,
    pages: d.pages,
  }));
  const history = tablesFromRows(await historyRepo(ctx.sql).listForSymbol(symbol));
  return { documents, history };
}
