import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryVectorStore } from "@/lib/adapters/vector-store/in-memory";
import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { OcrPort } from "@/lib/domain/ports/ocr-port";
import type {
  PdfTextPort,
  PdfTextResult,
} from "@/lib/domain/ports/pdf-text-port";
import type { IngestEvent } from "@/lib/domain/types";

import { ingestPdf } from "./ingest-pdf";

const TEST_MODEL = "test-model";

function deterministicEmbed(text: string): number[] {
  let h1 = 2166136261;
  let h2 = 1779033703;
  for (let i = 0; i < text.length; i++) {
    h1 ^= text.charCodeAt(i);
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + text.charCodeAt(i) * 31) >>> 0;
  }
  return [h1 / 0xffffffff, h2 / 0xffffffff];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestPdf integration (mocked mixed-path)", () => {
  it("aggregates per-page chunks via the real chunker, emits events in page order, and second run is a cache hit", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "ingest-pdf-int-"));
    try {
      const store = new InMemoryVectorStore({
        embeddingModel: TEST_MODEL,
        cacheBaseDir: cacheDir,
      });

      const longTextPage1 = "The quick brown fox jumps over the lazy dog. ".repeat(120);
      const longOcrText = "Extracted plan-set page two. ".repeat(120);

      const pdfText: PdfTextPort = {
        async extractPages(): Promise<PdfTextResult> {
          return {
            pages: [
              { page: 1, text: longTextPage1, usable: true },
              { page: 2, text: "", usable: false },
              { page: 3, text: "third spec section.", usable: true },
            ],
            errors: [],
          };
        },
      };

      const ocr: OcrPort = {
        async extractPageText({ page }) {
          if (page !== 2) {
            throw new Error(`unexpected OCR call for page ${page}`);
          }
          return { text: longOcrText, cached: false };
        },
      };

      const embedSpy = vi.fn(async (texts: string[]) => texts.map(deterministicEmbed));
      const embeddings: EmbeddingsPort = { embedTexts: embedSpy };

      const events: IngestEvent[] = [];
      const fileHash = "mixed-hash";
      const filePath = "/tmp/mixed.pdf";

      await ingestPdf(
        filePath,
        fileHash,
        (e) => events.push(e),
        {
          pdfText,
          ocr,
          embeddings,
          store,
          readFile: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          statFile: async () => ({ size: 4 }),
          rasterize: async (_pdf, pages) => {
            const out = new Map<number, Uint8Array>();
            for (const p of pages) out.set(p, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
            return out;
          },
        },
      );

      const kinds = events.map((e) => e.kind);
      expect(kinds[0]).toBe("file-start");
      expect(kinds[kinds.length - 1]).toBe("file-done");

      const progress = events.filter((e) => e.kind === "page-progress") as Array<
        Extract<IngestEvent, { kind: "page-progress" }>
      >;
      expect(progress.map((e) => e.page)).toEqual([1, 2, 3]);
      expect(progress.map((e) => e.path)).toEqual(["text", "vision", "text"]);

      expect(store.has(fileHash)).toBe(true);

      const sample = store.search(deterministicEmbed(longTextPage1), 100);
      expect(sample.length).toBeGreaterThanOrEqual(3);
      for (const hit of sample) {
        expect(hit.chunk.sourceRef.type).toBe("pdf-page");
        expect((hit.chunk.sourceRef as { file: string }).file).toBe("mixed.pdf");
      }

      const done = events[events.length - 1] as Extract<IngestEvent, { kind: "file-done" }>;
      expect(done.cached).toBe(false);
      expect(done.chunks).toBeGreaterThanOrEqual(3);

      const initialCalls = embedSpy.mock.calls.length;
      const cachedEvents: IngestEvent[] = [];

      await ingestPdf(
        filePath,
        fileHash,
        (e) => cachedEvents.push(e),
        {
          pdfText,
          ocr,
          embeddings,
          store,
          readFile: async () => new Uint8Array(),
          statFile: async () => ({ size: 4 }),
          rasterize: async () => new Map<number, Uint8Array>(),
        },
      );

      const cachedKinds = cachedEvents.map((e) => e.kind);
      expect(cachedKinds).toEqual(["file-start", "file-done"]);
      const cachedDone = cachedEvents[1] as Extract<IngestEvent, { kind: "file-done" }>;
      expect(cachedDone.cached).toBe(true);
      expect(cachedDone.chunks).toBe(0);
      expect(embedSpy.mock.calls.length).toBe(initialCalls);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
