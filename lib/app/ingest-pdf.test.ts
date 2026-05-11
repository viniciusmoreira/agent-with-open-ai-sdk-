import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OcrAdapterError } from "@/lib/adapters/pdf/vision-ocr";
import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { OcrPort } from "@/lib/domain/ports/ocr-port";
import type {
  PdfPageText,
  PdfTextPort,
  PdfTextResult,
} from "@/lib/domain/ports/pdf-text-port";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import type { Chunk, DomainError, IngestEvent } from "@/lib/domain/types";

import { ingestPdf, type IngestPdfDeps } from "./ingest-pdf";

type Recorded = IngestEvent[];

function makeStore(initialHas = false) {
  let present = initialHas;
  const upserts: Array<{ fileHash: string; chunks: Chunk[] }> = [];
  const store: VectorStorePort = {
    async hydrate() {},
    has() {
      return present;
    },
    async upsert(fileHash, chunks) {
      upserts.push({ fileHash, chunks });
      present = true;
    },
    search() {
      return [];
    },
  };
  return {
    store,
    upserts,
    setHas: (v: boolean) => {
      present = v;
    },
  };
}

function makeEmbeddings(
  impl?: (texts: string[]) => Promise<number[][]>,
): { port: EmbeddingsPort; embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(
    impl ?? (async (texts: string[]) => texts.map((_t, i) => [i + 1, (i + 1) * 0.1])),
  );
  return { port: { embedTexts: embed }, embed };
}

function makePdfText(result: PdfTextResult): {
  port: PdfTextPort;
  extract: ReturnType<typeof vi.fn>;
} {
  const extract = vi.fn(async () => result);
  return { port: { extractPages: extract }, extract };
}

function makeOcr(
  impl?: (page: number) => Promise<string>,
): { port: OcrPort; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async ({ page }: { page: number; pageImage: Uint8Array }) => {
    const text = impl ? await impl(page) : `ocr-text-${page}`;
    return { text, cached: false };
  });
  return { port: { extractPageText: call }, call };
}

function page(p: number, text: string, usable: boolean): PdfPageText {
  return { page: p, text, usable };
}

const PDF_BYTES = new Uint8Array([1, 2, 3, 4]);

function baseDeps(overrides: Partial<IngestPdfDeps> & {
  pdfText: PdfTextPort;
  ocr: OcrPort;
  embeddings: EmbeddingsPort;
  store: VectorStorePort;
}): IngestPdfDeps {
  return {
    readFile: async () => PDF_BYTES,
    statFile: async () => ({ size: PDF_BYTES.byteLength }),
    rasterize: async (_pdf, p) => new Uint8Array([0xff, p & 0xff]),
    chunk: (text) => (text.trim().length > 0 ? [text.trim()] : []),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestPdf", () => {
  it("text-only PDF: every page emits page-progress(text) and OCR is never called", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "page-1-text", true), page(2, "page-2-text", true)],
      errors: [],
    });
    const ocr = makeOcr();
    const { port: embeddings, embed } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/specs.pdf",
      "hash-text",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr: ocr.port, embeddings, store: store.store }),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "file-start",
      "page-progress",
      "page-progress",
      "file-done",
    ]);
    expect(
      events
        .filter((e) => e.kind === "page-progress")
        .map((e) => (e as Extract<IngestEvent, { kind: "page-progress" }>).path),
    ).toEqual(["text", "text"]);
    expect(ocr.call).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0]!.chunks).toHaveLength(2);
  });

  it("scanned PDF: every page falls through to OCR with page-progress(vision)", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "", false), page(2, "garbled", false)],
      errors: [],
    });
    const ocr = makeOcr();
    const { port: embeddings, embed } = makeEmbeddings();
    const store = makeStore();
    const rasterize = vi.fn(async (_pdf: Uint8Array, p: number) => new Uint8Array([p]));

    await ingestPdf(
      "/tmp/plans.pdf",
      "hash-scan",
      (e) => events.push(e),
      baseDeps({
        pdfText,
        ocr: ocr.port,
        embeddings,
        store: store.store,
        rasterize,
      }),
    );

    const progress = events.filter((e) => e.kind === "page-progress");
    expect(progress.map((e) => (e as Extract<IngestEvent, { kind: "page-progress" }>).path)).toEqual([
      "vision",
      "vision",
    ]);
    expect(ocr.call).toHaveBeenCalledTimes(2);
    expect(rasterize).toHaveBeenCalledTimes(2);
    expect(rasterize.mock.calls.map((c) => c[1])).toEqual([1, 2]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(store.upserts[0]!.chunks).toHaveLength(2);
  });

  it("mixed PDF: page 1 uses text-layer, page 2 falls through to OCR", async () => {
    const events: Recorded = [];
    const { port: pdfText, extract } = makePdfText({
      pages: [page(1, "real text", true), page(2, "", false)],
      errors: [],
    });
    const ocr = makeOcr();
    const { port: embeddings } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/mixed.pdf",
      "hash-mixed",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr: ocr.port, embeddings, store: store.store }),
    );

    expect(extract).toHaveBeenCalledTimes(1);
    const pathByPage = events
      .filter((e) => e.kind === "page-progress")
      .map((e) => {
        const ev = e as Extract<IngestEvent, { kind: "page-progress" }>;
        return [ev.page, ev.path] as const;
      });
    expect(pathByPage).toEqual([
      [1, "text"],
      [2, "vision"],
    ]);
    expect(ocr.call).toHaveBeenCalledTimes(1);
    expect(ocr.call.mock.calls[0]![0].page).toBe(2);
  });

  it("each upserted Chunk has sourceRef={ type: 'pdf-page', file, page, chunkIndex }", async () => {
    const { port: pdfText } = makePdfText({
      pages: [page(1, "alpha beta", true), page(2, "", false)],
      errors: [],
    });
    const ocr = makeOcr(async (p) => `vision-${p}-text`);
    const { port: embeddings } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/specs.pdf",
      "hash-ref",
      () => {},
      baseDeps({
        pdfText,
        ocr: ocr.port,
        embeddings,
        store: store.store,
        // Force two chunks per page so chunkIndex 0 and 1 both appear.
        chunk: (text) => [`${text}//A`, `${text}//B`],
      }),
    );

    const chunks = store.upserts[0]!.chunks;
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.sourceRef)).toEqual([
      { type: "pdf-page", file: "specs.pdf", page: 1, chunkIndex: 0 },
      { type: "pdf-page", file: "specs.pdf", page: 1, chunkIndex: 1 },
      { type: "pdf-page", file: "specs.pdf", page: 2, chunkIndex: 0 },
      { type: "pdf-page", file: "specs.pdf", page: 2, chunkIndex: 1 },
    ]);
    expect(chunks.map((c) => c.id)).toEqual([
      "hash-ref:pdf-page:1:0",
      "hash-ref:pdf-page:1:1",
      "hash-ref:pdf-page:2:0",
      "hash-ref:pdf-page:2:1",
    ]);
    for (const c of chunks) {
      expect(c.vector).toBeInstanceOf(Float32Array);
      expect(c.vector.length).toBeGreaterThan(0);
    }
  });

  it("short-circuits with cached:true when store.has(fileHash) is true", async () => {
    const events: Recorded = [];
    const { port: pdfText, extract } = makePdfText({ pages: [], errors: [] });
    const ocr = makeOcr();
    const { port: embeddings, embed } = makeEmbeddings();
    const store = makeStore(true);
    const readFile = vi.fn(async () => PDF_BYTES);

    await ingestPdf(
      "/tmp/cached.pdf",
      "hash-cached",
      (e) => events.push(e),
      baseDeps({
        pdfText,
        ocr: ocr.port,
        embeddings,
        store: store.store,
        readFile,
      }),
    );

    expect(events.map((e) => e.kind)).toEqual(["file-start", "file-done"]);
    expect(events[1]).toMatchObject({
      kind: "file-done",
      file: "cached.pdf",
      chunks: 0,
      cached: true,
    });
    expect(extract).not.toHaveBeenCalled();
    expect(ocr.call).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(store.upserts).toHaveLength(0);
  });

  it("OCR failure on one page emits file-error and continues with later pages", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [
        page(1, "good text", true),
        page(2, "", false),
        page(3, "", false),
      ],
      errors: [],
    });
    const ocrErr = new OcrAdapterError({
      kind: "ocr",
      message: "vision OCR failed on page 2",
      page: 2,
    });
    const call = vi.fn(async ({ page: p }: { page: number; pageImage: Uint8Array }) => {
      if (p === 2) throw ocrErr;
      return { text: `ocr-${p}`, cached: false };
    });
    const ocr: OcrPort = { extractPageText: call };
    const { port: embeddings, embed } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/p.pdf",
      "hash-deg",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr, embeddings, store: store.store }),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "file-start",
      "page-progress",
      "file-error",
      "page-progress",
      "file-done",
    ]);
    const errorEvent = events[2] as Extract<IngestEvent, { kind: "file-error" }>;
    expect((errorEvent.detail as DomainError).kind).toBe("ocr");
    expect((errorEvent.detail as DomainError).message).toContain("page 2");

    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0]!.chunks).toHaveLength(2);
    expect(
      store.upserts[0]!.chunks.map((c) => (c.sourceRef as { page: number }).page),
    ).toEqual([1, 3]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("surfaces text-layer errors from the port as file-error events", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "text", true)],
      errors: [
        { kind: "pdf", message: "failed to extract page 2", file: "x.pdf", page: 2 },
      ],
    });
    const ocr = makeOcr();
    const { port: embeddings } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/x.pdf",
      "hash-x",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr: ocr.port, embeddings, store: store.store }),
    );

    const errors = events.filter((e) => e.kind === "file-error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Extract<IngestEvent, { kind: "file-error" }>).message).toContain(
      "failed to extract page 2",
    );
  });

  it("emits file-error and bails out when stat fails before file-start", async () => {
    const events: Recorded = [];
    const { port: pdfText, extract } = makePdfText({ pages: [], errors: [] });
    const ocr = makeOcr();
    const { port: embeddings } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/missing.pdf",
      "hash-missing",
      (e) => events.push(e),
      baseDeps({
        pdfText,
        ocr: ocr.port,
        embeddings,
        store: store.store,
        statFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    );

    expect(events.map((e) => e.kind)).toEqual(["file-error"]);
    expect(extract).not.toHaveBeenCalled();
  });

  it("emits file-error when readFile throws after file-start", async () => {
    const events: Recorded = [];
    const { port: pdfText, extract } = makePdfText({ pages: [], errors: [] });
    const ocr = makeOcr();
    const { port: embeddings } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/io.pdf",
      "hash-io",
      (e) => events.push(e),
      baseDeps({
        pdfText,
        ocr: ocr.port,
        embeddings,
        store: store.store,
        readFile: async () => {
          throw new Error("EACCES");
        },
      }),
    );

    expect(events.map((e) => e.kind)).toEqual(["file-start", "file-error"]);
    expect(extract).not.toHaveBeenCalled();
  });

  it("emits file-error when embeddings throw", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "abc", true)],
      errors: [],
    });
    const ocr = makeOcr();
    const embed = vi.fn(async () => {
      throw new Error("rate-limited");
    });
    const embeddings: EmbeddingsPort = { embedTexts: embed };
    const store = makeStore();

    await ingestPdf(
      "/tmp/e.pdf",
      "hash-e",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr: ocr.port, embeddings, store: store.store }),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("file-error");
    expect(kinds).not.toContain("file-done");
    expect(store.upserts).toHaveLength(0);
  });

  it("wraps non-OcrAdapterError causes into DomainError(kind:'ocr') and continues", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "", false), page(2, "fine", true)],
      errors: [],
    });
    const rasterize = vi.fn(async () => {
      throw new Error("rasterizer crash");
    });
    const ocr = makeOcr();
    const { port: embeddings } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/r.pdf",
      "hash-r",
      (e) => events.push(e),
      baseDeps({
        pdfText,
        ocr: ocr.port,
        embeddings,
        store: store.store,
        rasterize,
      }),
    );

    const errorEvent = events.find((e) => e.kind === "file-error") as
      | Extract<IngestEvent, { kind: "file-error" }>
      | undefined;
    expect(errorEvent).toBeDefined();
    const detail = errorEvent!.detail as DomainError;
    expect(detail.kind).toBe("ocr");
    expect(detail.message).toContain("page 1");
    expect(detail.message).toContain("rasterizer crash");
    // page 2 still succeeds via text path
    expect(store.upserts[0]!.chunks.map((c) => (c.sourceRef as { page: number }).page)).toEqual([2]);
  });

  it("describes non-Error throw payloads (string) without losing the file-error frame", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "abc", true)],
      errors: [],
    });
    const embed = vi.fn(async () => {
      // throw a non-Error value to exercise the describe(string) branch
      throw "string-boom";
    });
    const embeddings: EmbeddingsPort = { embedTexts: embed };
    const ocr = makeOcr();
    const store = makeStore();

    await ingestPdf(
      "/tmp/s.pdf",
      "hash-s",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr: ocr.port, embeddings, store: store.store }),
    );

    const err = events.find((e) => e.kind === "file-error") as
      | Extract<IngestEvent, { kind: "file-error" }>
      | undefined;
    expect(err).toBeDefined();
    expect(err!.message).toContain("string-boom");
  });

  it("emits file-error when text-layer port itself throws (not via result.errors)", async () => {
    const events: Recorded = [];
    const port: PdfTextPort = {
      async extractPages() {
        throw new Error("text-layer crashed");
      },
    };
    const ocr = makeOcr();
    const { port: embeddings } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/c.pdf",
      "hash-c",
      (e) => events.push(e),
      baseDeps({ pdfText: port, ocr: ocr.port, embeddings, store: store.store }),
    );

    expect(events.map((e) => e.kind)).toEqual(["file-start", "file-error"]);
    expect((events[1] as Extract<IngestEvent, { kind: "file-error" }>).message).toContain(
      "text-layer crashed",
    );
  });

  it("emits file-error when store.upsert throws", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "abc", true)],
      errors: [],
    });
    const ocr = makeOcr();
    const { port: embeddings } = makeEmbeddings();
    const store: VectorStorePort = {
      async hydrate() {},
      has: () => false,
      upsert: async () => {
        throw new Error("disk full");
      },
      search: () => [],
    };

    await ingestPdf(
      "/tmp/u.pdf",
      "hash-u",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr: ocr.port, embeddings, store }),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("file-error");
    expect(kinds).not.toContain("file-done");
    expect((events.at(-1) as Extract<IngestEvent, { kind: "file-error" }>).message).toContain(
      "disk full",
    );
  });

  it("emits file-error when embed count does not match chunk count", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "abc", true), page(2, "def", true)],
      errors: [],
    });
    const embed = vi.fn(async () => [[1, 2]]); // returns 1, not 2
    const embeddings: EmbeddingsPort = { embedTexts: embed };
    const ocr = makeOcr();
    const store = makeStore();

    await ingestPdf(
      "/tmp/mm.pdf",
      "hash-mm",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr: ocr.port, embeddings, store: store.store }),
    );

    const err = events.find((e) => e.kind === "file-error");
    expect(err).toBeDefined();
    expect((err as Extract<IngestEvent, { kind: "file-error" }>).message).toMatch(
      /Embedding count/,
    );
    expect(store.upserts).toHaveLength(0);
  });

  it("exercises default readFile/statFile/chunk against a real file on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ingest-pdf-default-"));
    try {
      const filePath = path.join(dir, "real.pdf");
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
      await writeFile(filePath, bytes);

      const events: Recorded = [];
      const { port: pdfText } = makePdfText({
        pages: [page(1, "real-fs path text", true)],
        errors: [],
      });
      const ocr = makeOcr();
      const { port: embeddings, embed } = makeEmbeddings();
      const store = makeStore();

      // No readFile / statFile / chunk overrides — exercise the defaults.
      await ingestPdf(filePath, "hash-real", (e) => events.push(e), {
        pdfText,
        ocr: ocr.port,
        embeddings,
        store: store.store,
      });

      expect(events.map((e) => e.kind)).toEqual([
        "file-start",
        "page-progress",
        "file-done",
      ]);
      const start = events[0] as Extract<IngestEvent, { kind: "file-start" }>;
      expect(start.sizeBytes).toBe(bytes.byteLength);
      expect(embed).toHaveBeenCalledTimes(1);
      expect(store.upserts[0]!.chunks).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits file-done with chunks:0 when no page produced text (graceful degradation)", async () => {
    const events: Recorded = [];
    const { port: pdfText } = makePdfText({
      pages: [page(1, "", false)],
      errors: [],
    });
    const call = vi.fn(async () => {
      throw new OcrAdapterError({
        kind: "ocr",
        message: "boom",
        page: 1,
      });
    });
    const ocr: OcrPort = { extractPageText: call };
    const { port: embeddings, embed } = makeEmbeddings();
    const store = makeStore();

    await ingestPdf(
      "/tmp/empty.pdf",
      "hash-empty",
      (e) => events.push(e),
      baseDeps({ pdfText, ocr, embeddings, store: store.store }),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["file-start", "file-error", "file-done"]);
    const done = events.at(-1) as Extract<IngestEvent, { kind: "file-done" }>;
    expect(done.chunks).toBe(0);
    expect(done.cached).toBe(false);
    expect(embed).not.toHaveBeenCalled();
    expect(store.upserts).toHaveLength(0);
  });
});
