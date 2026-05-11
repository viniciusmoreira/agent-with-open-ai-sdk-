import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createPdfTextLayer, isUsable } from "./text-layer";

const fixturesDir = resolve(__dirname, "../../../tests/fixtures/pdf");

let twoPagePdf: Uint8Array;
let scannedPdf: Uint8Array;

beforeAll(async () => {
  twoPagePdf = new Uint8Array(
    await readFile(resolve(fixturesDir, "two-page-text.pdf")),
  );
  scannedPdf = new Uint8Array(
    await readFile(resolve(fixturesDir, "scanned-page.pdf")),
  );
});

describe("createPdfTextLayer.extractPages", () => {
  it("yields two usable records with non-empty text for the textual fixture", async () => {
    const port = createPdfTextLayer();
    const result = await port.extractPages({
      pdf: twoPagePdf,
      file: "specs.pdf",
    });
    expect(result.errors).toEqual([]);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.page).toBe(1);
    expect(result.pages[1]?.page).toBe(2);
    for (const page of result.pages) {
      expect(page.usable).toBe(true);
      expect(page.text.length).toBeGreaterThan(0);
    }
    expect(result.pages[0]?.text).toMatch(/textual/i);
    expect(result.pages[1]?.text).toMatch(/page two/i);
  });

  it("flags a page with an empty text layer as unusable and returns text = ''", async () => {
    const port = createPdfTextLayer();
    const result = await port.extractPages({
      pdf: scannedPdf,
      file: "plans.pdf",
    });
    expect(result.errors).toEqual([]);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toEqual({ page: 1, text: "", usable: false });
  });

  it("flags pages below the printable-character ratio threshold as unusable", () => {
    expect(isUsable("clean construction specification", 0.7)).toBe(true);
    expect(isUsable("", 0.7)).toBe(false);
    expect(isUsable("    \n\t  ", 0.7)).toBe(false);
    const controls = String.fromCharCode(
      1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16,
    );
    // 7 letters + 13 control chars => printable ratio = 7/20 = 0.35
    expect(isUsable("abcdefg" + controls, 0.7)).toBe(false);
  });

  it("emits a DomainError carrying the file path on an invalid PDF input", async () => {
    const port = createPdfTextLayer();
    const result = await port.extractPages({
      pdf: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      file: "broken.pdf",
    });
    expect(result.pages).toEqual([]);
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!;
    expect(err.kind).toBe("pdf");
    if (err.kind === "pdf") {
      expect(err.file).toBe("broken.pdf");
      expect(err.message).toMatch(/failed to open pdf/i);
    }
  });

  it("invokes the onPage hook once per page in order (lazy progress)", async () => {
    const seen: number[] = [];
    const port = createPdfTextLayer({
      onPage: (p) => {
        seen.push(p.page);
      },
    });
    const result = await port.extractPages({
      pdf: twoPagePdf,
      file: "specs.pdf",
    });
    expect(seen).toEqual([1, 2]);
    expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
  });
});

describe("integration: full extraction over multi-page textual fixture", () => {
  it("returns page numbers 1 and 2 in order with content distinguishable per page", async () => {
    const port = createPdfTextLayer();
    const result = await port.extractPages({
      pdf: twoPagePdf,
      file: "specs.pdf",
    });
    expect(result.errors).toEqual([]);
    expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(result.pages[0]?.text).not.toBe(result.pages[1]?.text);
  });
});
