import { extractText, getDocumentProxy } from "unpdf";
import type { PdfPage } from "../types";

export interface ExtractOptions {
  /** Stop after this many pages (annual reports can run to 400+). */
  maxPages?: number;
}

export async function extractPdfPages(data: Uint8Array, options: ExtractOptions = {}): Promise<PdfPage[]> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const limit = Math.min(text.length, options.maxPages ?? Number.POSITIVE_INFINITY);
    const pages: PdfPage[] = [];
    for (let i = 0; i < limit; i++) {
      pages.push({ page: i + 1, text: normalisePdfText(text[i] ?? "") });
    }
    return pages;
  } finally {
    await pdf.cleanup?.();
  }
}

export function normalisePdfText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Scanned PDFs extract to almost nothing; flag them instead of indexing empty pages. */
export function looksScanned(pages: PdfPage[]): boolean {
  if (pages.length === 0) return true;
  const chars = pages.reduce((n, p) => n + p.text.length, 0);
  return chars / pages.length < 200;
}
