import { performance } from "node:perf_hooks";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createPdfTextLayer } from "./text-layer";

describe.skipIf(!process.env.PDF_BENCH)("benchmark: 100-page textual PDF", () => {
  it("extracts 100 pages in under 5 seconds", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 100; i++) {
      const p = pdf.addPage([400, 600]);
      p.setFont(font);
      p.setFontSize(11);
      for (let line = 0; line < 30; line++) {
        p.drawText(`Section ${i} line ${line}: pavement specification.`, {
          x: 30,
          y: 580 - line * 18,
        });
      }
    }
    const bytes = new Uint8Array(await pdf.save({ useObjectStreams: false }));
    const port = createPdfTextLayer();
    const t = performance.now();
    const r = await port.extractPages({ pdf: bytes, file: "bench.pdf" });
    const elapsedMs = performance.now() - t;
    expect(r.pages).toHaveLength(100);
    expect(r.errors).toEqual([]);
    expect(elapsedMs).toBeLessThan(5000);
  });
});
