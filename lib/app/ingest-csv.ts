import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";

import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import type { Chunk, IngestEvent, ParseResult } from "@/lib/domain/types";
import { parseBids } from "@/lib/domain/csv/parse";

import { setCsvRows } from "./csv-row-cache";

export type IngestCsvEmit = (event: IngestEvent) => void;

export type IngestCsvDeps = {
  embeddings: EmbeddingsPort;
  store: VectorStorePort;
  readFile?: (filePath: string) => Promise<string>;
  statFile?: (filePath: string) => Promise<{ size: number }>;
  parse?: (csvText: string) => ParseResult;
};

export async function ingestCsv(
  filePath: string,
  fileHash: string,
  emit: IngestCsvEmit,
  deps: IngestCsvDeps,
): Promise<void> {
  const file = path.basename(filePath);
  const readFile = deps.readFile ?? defaultReadFile;
  const statFile = deps.statFile ?? defaultStat;
  const parse = deps.parse ?? parseBids;

  let sizeBytes = 0;
  try {
    const info = await statFile(filePath);
    sizeBytes = info.size;
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to stat CSV file: ${describeError(cause)}`,
      detail: { filePath, cause },
    });
    return;
  }

  emit({ kind: "file-start", file, sizeBytes });

  if (deps.store.has(fileHash)) {
    emit({ kind: "file-done", file, chunks: 0, cached: true });
    return;
  }

  let csvText: string;
  try {
    csvText = await readFile(filePath);
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to read CSV file: ${describeError(cause)}`,
      detail: { filePath, cause },
    });
    return;
  }

  const result = parse(csvText);

  for (const err of result.errors) {
    emit({
      kind: "file-error",
      file,
      message: err.message,
      detail: "detail" in err ? err.detail : undefined,
    });
  }

  if (result.rows.length === 0) {
    return;
  }

  setCsvRows(fileHash, result);
  emit({ kind: "csv-progress", file, rows: result.rows.length });

  const itemDescs = result.rows.map((row) => row.itemDesc);
  let vectors: number[][];
  try {
    vectors = await deps.embeddings.embedTexts(itemDescs);
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to embed item descriptions: ${describeError(cause)}`,
      detail: { cause },
    });
    return;
  }

  if (vectors.length !== result.rows.length) {
    emit({
      kind: "file-error",
      file,
      message: `Embedding count (${vectors.length}) does not match row count (${result.rows.length})`,
    });
    return;
  }

  const chunks: Chunk[] = result.rows.map((row, index) => ({
    id: `${fileHash}:csv-row:${row.rowId}`,
    text: row.itemDesc,
    vector: Float32Array.from(vectors[index] ?? []),
    sourceRef: { type: "csv-row", file, rowId: row.rowId },
  }));

  try {
    await deps.store.upsert(fileHash, chunks);
  } catch (cause) {
    emit({
      kind: "file-error",
      file,
      message: `Failed to upsert chunks: ${describeError(cause)}`,
      detail: { cause },
    });
    return;
  }

  emit({
    kind: "file-done",
    file,
    chunks: chunks.length,
    cached: false,
    unmapped: result.unmapped,
  });
}

function defaultReadFile(filePath: string): Promise<string> {
  return fsReadFile(filePath, "utf8");
}

async function defaultStat(filePath: string): Promise<{ size: number }> {
  const info = await fsStat(filePath);
  return { size: info.size };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
