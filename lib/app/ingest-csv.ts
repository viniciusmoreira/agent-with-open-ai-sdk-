import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";

import { readJsonIfPresent, writeJsonAtomic } from "@/lib/adapters/cache/atomic-json";
import { cacheRoot } from "@/lib/adapters/cache/paths";
import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import type {
  BidRow,
  Chunk,
  ColumnMap,
  IngestEvent,
  ParseResult,
} from "@/lib/domain/types";
import { parseBids } from "@/lib/domain/csv/parse";

import { getCsvRows, setCsvRows } from "./csv-row-cache";

export type IngestCsvEmit = (event: IngestEvent) => void;

export type PersistCsvRowsFn = (
  fileHash: string,
  result: ParseResult,
  baseDir?: string,
) => Promise<void>;

export type LoadCsvRowsFn = (
  fileHash: string,
  baseDir?: string,
) => Promise<ParseResult | null>;

export type IngestCsvDeps = {
  embeddings: EmbeddingsPort;
  store: VectorStorePort;
  readFile?: (filePath: string) => Promise<string>;
  statFile?: (filePath: string) => Promise<{ size: number }>;
  parse?: (csvText: string) => ParseResult;
  cacheBaseDir?: string;
  persistCsvRows?: PersistCsvRowsFn;
  loadCsvRows?: LoadCsvRowsFn;
};

const CSV_ROWS_NAMESPACE = "csv-rows";

type PersistedCsvRows = {
  rows: BidRow[];
  columnMap: ColumnMap;
  unmapped: string[];
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
  const persist = deps.persistCsvRows ?? defaultPersistCsvRows;
  const load = deps.loadCsvRows ?? defaultLoadCsvRows;

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
    const rehydrated = await tryLoadCsvRows(fileHash, load, deps.cacheBaseDir);
    if (rehydrated) {
      setCsvRows(fileHash, rehydrated);
      emit({ kind: "file-done", file, chunks: 0, cached: true });
      return;
    }
    // Row cache missing on disk — fall through to a full re-parse so that
    // query_bids / find_outliers can still answer. Chunk IDs are deterministic,
    // so the eventual upsert is idempotent against the existing embeddings.
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

  try {
    await persist(fileHash, result, deps.cacheBaseDir);
  } catch (cause) {
    // Persistence failure degrades the next-restart cache hit to a re-parse,
    // but the current session is fully functional — log and continue.
    console.error(
      JSON.stringify({
        scope: "ingest-csv",
        message: "failed to persist csv row cache",
        fileHash,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }

  emit({
    kind: "file-done",
    file,
    chunks: chunks.length,
    cached: false,
    unmapped: result.unmapped,
  });
}

export async function rehydrateCsvRowsFromDisk(
  fileHash: string,
  options: { cacheBaseDir?: string; loadCsvRows?: LoadCsvRowsFn } = {},
): Promise<boolean> {
  if (getCsvRows(fileHash)) return true;
  const load = options.loadCsvRows ?? defaultLoadCsvRows;
  const parsed = await tryLoadCsvRows(fileHash, load, options.cacheBaseDir);
  if (!parsed) return false;
  setCsvRows(fileHash, parsed);
  return true;
}

export function csvRowsCachePath(fileHash: string, baseDir?: string): string {
  return path.join(cacheRoot(baseDir), CSV_ROWS_NAMESPACE, `${fileHash}.json`);
}

async function tryLoadCsvRows(
  fileHash: string,
  load: LoadCsvRowsFn,
  baseDir?: string,
): Promise<ParseResult | null> {
  try {
    return await load(fileHash, baseDir);
  } catch (cause) {
    console.error(
      JSON.stringify({
        scope: "ingest-csv",
        message: "failed to load csv row cache",
        fileHash,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return null;
  }
}

async function defaultLoadCsvRows(
  fileHash: string,
  baseDir?: string,
): Promise<ParseResult | null> {
  const persisted = await readJsonIfPresent<PersistedCsvRows>(
    csvRowsCachePath(fileHash, baseDir),
  );
  if (!persisted) return null;
  return {
    rows: persisted.rows,
    columnMap: persisted.columnMap,
    unmapped: persisted.unmapped,
    errors: [],
  };
}

async function defaultPersistCsvRows(
  fileHash: string,
  result: ParseResult,
  baseDir?: string,
): Promise<void> {
  const payload: PersistedCsvRows = {
    rows: result.rows,
    columnMap: result.columnMap,
    unmapped: result.unmapped,
  };
  await writeJsonAtomic(csvRowsCachePath(fileHash, baseDir), payload);
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
