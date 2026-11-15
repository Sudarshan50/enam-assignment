import { describe, expect, it } from "vitest";
import { extractPdfPages, looksScanned, normalisePdfText } from "../src/pdf/extract";

/** A valid PDF with one Helvetica text line per entry; each page is a list of lines. */
function buildPdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const content = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("extractPdfPages", () => {
  it("returns 1-based pages with normalised text", async () => {
    const pdf = buildPdf([["Revenue   grew", "by 12 percent"], ["Page two"], ["Guidance: margin 26%"]]);
    expect(await extractPdfPages(pdf)).toEqual([
      { page: 1, text: "Revenue grew\nby 12 percent" },
      { page: 2, text: "Page two" },
      { page: 3, text: "Guidance: margin 26%" },
    ]);
  });

  it("stops at maxPages", async () => {
    const pages = await extractPdfPages(buildPdf([["a"], ["b"], ["c"]]), { maxPages: 2 });
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it("does not detach the caller's buffer", async () => {
    const pdf = buildPdf([["keep me"]]);
    await extractPdfPages(pdf);
    expect(pdf.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toBe("%PDF-1.4");
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(extractPdfPages(new TextEncoder().encode("<html>not a pdf</html>"))).rejects.toThrow();
  });
});

describe("normalisePdfText", () => {
  it("drops NULs, collapses runs of spaces and blank lines, and trims", () => {
    expect(normalisePdfText("  Net\u0000 profit \t\f rose  \n  by 5%\n\n\n\n\nNext   para  ")).toBe("Net profit rose\nby 5%\n\nNext para");
  });
});

describe("looksScanned", () => {
  const pageOf = (n: number, page = 1) => ({ page, text: "x".repeat(n) });

  it("treats an empty document or under 200 characters per page as scanned", () => {
    expect(looksScanned([])).toBe(true);
    expect(looksScanned([pageOf(199)])).toBe(true);
    expect(looksScanned([pageOf(200)])).toBe(false);
    expect(looksScanned([pageOf(390, 1), pageOf(0, 2)])).toBe(true);
    expect(looksScanned([pageOf(400, 1), pageOf(0, 2)])).toBe(false);
  });
});
