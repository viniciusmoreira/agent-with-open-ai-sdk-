import { describe, expect, it } from "vitest";

import type { Chunk, SourceRef } from "../types";
import type { EmbeddingsPort } from "./embeddings-port";
import type { OcrPort } from "./ocr-port";
import type { PdfTextPort } from "./pdf-text-port";
import type { VectorStorePort } from "./vector-store-port";

describe("port contracts", () => {
  it("EmbeddingsPort accepts a placeholder adapter that returns deterministic vectors", async () => {
    const adapter: EmbeddingsPort = {
      embedTexts: async (texts) =>
        texts.map((t) => Array.from({ length: 4 }, (_, i) => t.length + i)),
    };
    const vectors = await adapter.embedTexts(["a", "bb"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([1, 2, 3, 4]);
    expect(vectors[1]).toEqual([2, 3, 4, 5]);
  });

  it("VectorStorePort accepts a placeholder adapter implementing all methods", async () => {
    const store = new Map<string, Chunk[]>();
    const adapter: VectorStorePort = {
      hydrate: async () => undefined,
      has: (fileHash) => store.has(fileHash),
      upsert: async (fileHash, chunks) => {
        store.set(fileHash, chunks);
      },
      search: (_q, k, filter) =>
        Array.from(store.values())
          .flat()
          .filter((c) => (filter ? filter(c.sourceRef) : true))
          .slice(0, k),
    };
    await adapter.hydrate();
    expect(adapter.has("missing")).toBe(false);
    const ref: SourceRef = { type: "csv-row", file: "bid.csv", rowId: 1 };
    const chunk: Chunk = {
      id: "h1:csv:1",
      text: "asphalt",
      vector: new Float32Array([0.1, 0.2]),
      sourceRef: ref,
    };
    await adapter.upsert("h1", [chunk]);
    expect(adapter.has("h1")).toBe(true);
    const hits = adapter.search([0, 0], 5, (r) => r.type === "csv-row");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("h1:csv:1");
  });

  it("OcrPort and PdfTextPort accept conforming placeholder adapters", async () => {
    const ocr: OcrPort = {
      extractPageText: async ({ pageImage, page }) => ({
        text: `page-${page}:${pageImage.byteLength}`,
        cached: false,
      }),
    };
    const pdfText: PdfTextPort = {
      extractPages: async ({ pdf, file }) => [
        { page: 1, text: `${file}:${pdf.byteLength}`, usable: true },
      ],
    };
    const ocrResult = await ocr.extractPageText({
      pageImage: new Uint8Array([1, 2, 3]),
      page: 1,
    });
    expect(ocrResult).toEqual({ text: "page-1:3", cached: false });
    const pdfResult = await pdfText.extractPages({
      pdf: new Uint8Array([0, 0]),
      file: "specs.pdf",
    });
    expect(pdfResult).toEqual([
      { page: 1, text: "specs.pdf:2", usable: true },
    ]);
  });
});
