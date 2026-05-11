import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";

import { OcrAdapterError, rasterizePdfPage } from "@/lib/adapters/pdf/vision-ocr";
import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { OcrPort } from "@/lib/domain/ports/ocr-port";
import type { PdfTextPort } from "@/lib/domain/ports/pdf-text-port";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import { chunkText } from "@/lib/domain/text/chunker";
import type { Chunk, DomainError, IngestEvent } from "@/lib/domain/types";

export type IngestPdfEmit = (event: IngestEvent) => void;

export type RasterizeFn = (
  pdf: Uint8Array,
  page: number,
  opts: { file: string },
) => Promise<Uint8Array>;

export type IngestPdfDeps = {
  pdfText: PdfTextPort;
  ocr: OcrPort;
  embeddings: EmbeddingsPort;
  store: VectorStorePort;
  readFile?: (filePath: string) => Promise<Uint8Array>;
  statFile?: (filePath: string) => Promise<{ size: number }>;
  rasterize?: RasterizeFn;
  chunk?: (text: string) => string[];
};

export async function ingestPdf(
  filePath: string,
  fileHash: string,
  emit: IngestPdfEmit,
  deps: IngestPdfDeps,
): Promise<void> {
  const file = path.basename(filePath);
  const readFile = deps.readFile ?? defaultReadFile;
  const statFile = deps.statFile ?? defaultStat;
  const rasterize = deps.rasterize ?? defaultRasterize;
  const chunk = deps.chunk ?? defaultChunk;

  let sizeBytes = 0;
  try {
    const info = await statFile(filePath);
    sizeBytes = info.size;
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to stat PDF file: ${describe(cause)}`,
      detail: { filePath, cause },
    });
    return;
  }

  emit({ kind: "file-start", file, sizeBytes });

  if (deps.store.has(fileHash)) {
    emit({ kind: "file-done", file, chunks: 0, cached: true });
    return;
  }

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await readFile(filePath);
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to read PDF file: ${describe(cause)}`,
      detail: { filePath, cause },
    });
    return;
  }

  let textResult;
  try {
    textResult = await deps.pdfText.extractPages({ pdf: pdfBytes, file });
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to extract PDF text layer: ${describe(cause)}`,
      detail: { cause },
    });
    return;
  }

  for (const err of textResult.errors) {
    emit({ kind: "file-error", file, message: err.message, detail: err });
  }

  const totalPages = textResult.pages.length;
  if (totalPages === 0) {
    return;
  }

  const collected: Chunk[] = [];
  for (const page of textResult.pages) {
    if (page.usable) {
      appendPageChunks(collected, fileHash, file, page.page, chunk(page.text));
      emit({
        kind: "page-progress",
        file,
        page: page.page,
        total: totalPages,
        path: "text",
      });
      continue;
    }

    try {
      const png = await rasterize(pdfBytes, page.page, { file });
      const ocrResult = await deps.ocr.extractPageText({
        pageImage: png,
        page: page.page,
      });
      appendPageChunks(collected, fileHash, file, page.page, chunk(ocrResult.text));
      emit({
        kind: "page-progress",
        file,
        page: page.page,
        total: totalPages,
        path: "vision",
      });
    } catch (cause) {
      const domainErr = toDomainError(cause, page.page);
      emit({
        kind: "file-error",
        file,
        message: domainErr.message,
        detail: domainErr,
      });
    }
  }

  if (collected.length === 0) {
    emit({ kind: "file-done", file, chunks: 0, cached: false });
    return;
  }

  let vectors: number[][];
  try {
    vectors = await deps.embeddings.embedTexts(collected.map((c) => c.text));
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to embed PDF chunks: ${describe(cause)}`,
      detail: { cause },
    });
    return;
  }

  if (vectors.length !== collected.length) {
    emit({
      kind: "file-error",
      file,
      message: `Embedding count (${vectors.length}) does not match chunk count (${collected.length})`,
    });
    return;
  }

  for (let i = 0; i < collected.length; i++) {
    collected[i]!.vector = Float32Array.from(vectors[i] ?? []);
  }

  try {
    await deps.store.upsert(fileHash, collected);
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to upsert PDF chunks: ${describe(cause)}`,
      detail: { cause },
    });
    return;
  }

  emit({
    kind: "file-done",
    file,
    chunks: collected.length,
    cached: false,
  });
}

function appendPageChunks(
  collected: Chunk[],
  fileHash: string,
  file: string,
  page: number,
  pieces: string[],
): void {
  for (let chunkIndex = 0; chunkIndex < pieces.length; chunkIndex++) {
    const text = pieces[chunkIndex];
    if (!text || text.length === 0) continue;
    collected.push({
      id: `${fileHash}:pdf-page:${page}:${chunkIndex}`,
      text,
      vector: new Float32Array(0),
      sourceRef: { type: "pdf-page", file, page, chunkIndex },
    });
  }
}

function toDomainError(cause: unknown, page: number): DomainError {
  if (cause instanceof OcrAdapterError) return cause.domainError;
  return {
    kind: "ocr",
    message: `OCR failed on page ${page}: ${describe(cause)}`,
    page,
    cause,
  };
}

function defaultReadFile(filePath: string): Promise<Uint8Array> {
  return fsReadFile(filePath).then((buf) => new Uint8Array(buf));
}

async function defaultStat(filePath: string): Promise<{ size: number }> {
  const info = await fsStat(filePath);
  return { size: info.size };
}

function defaultRasterize(
  pdf: Uint8Array,
  page: number,
  opts: { file: string },
): Promise<Uint8Array> {
  return rasterizePdfPage(pdf, page, { file: opts.file });
}

function defaultChunk(text: string): string[] {
  return chunkText(text);
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "unknown error";
}
