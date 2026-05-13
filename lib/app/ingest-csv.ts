import { readdir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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

// Mirrors `BidRow` from `lib/domain/types.ts`. Strict so unknown keys in a
// drifted on-disk payload fail closed and force a re-parse.
const bidRowSchema = z
  .object({
    rowId: z.number().int(),
    projectId: z.string(),
    county: z.string().optional(),
    letDate: z.string().optional(),
    itemNo: z.string(),
    itemDesc: z.string(),
    unit: z.string(),
    qty: z.number(),
    bidder: z.string(),
    bidRank: z.number().optional(),
    unitPrice: z.number(),
    extAmt: z.number(),
    bidTotal: z.number().optional(),
    raw: z.record(z.string(), z.string()),
  })
  .strict();

const columnMapSchema = z
  .object({
    projectId: z.string(),
    itemNo: z.string(),
    itemDesc: z.string(),
    unit: z.string(),
    qty: z.string(),
    unitPrice: z.string(),
    bidder: z.string(),
    county: z.string().optional(),
    letDate: z.string().optional(),
    bidRank: z.string().optional(),
    extAmt: z.string().optional(),
    bidTotal: z.string().optional(),
  })
  .strict();

const persistedCsvRowsSchema = z
  .object({
    rows: z.array(bidRowSchema),
    columnMap: columnMapSchema,
    unmapped: z.array(z.string()),
  })
  .strict();

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

let csvRowsHydrated = false;
let csvRowsHydrating: Promise<void> | null = null;

export function hydrateCsvRowCacheFromDisk(
  opts: { cacheBaseDir?: string } = {},
): Promise<void> {
  if (csvRowsHydrated) return Promise.resolve();
  if (csvRowsHydrating) return csvRowsHydrating;
  csvRowsHydrating = runCsvRowsHydrate(opts).finally(() => {
    csvRowsHydrating = null;
  });
  return csvRowsHydrating;
}

export function __resetCsvRowHydrateForTests(): void {
  csvRowsHydrated = false;
  csvRowsHydrating = null;
}

async function runCsvRowsHydrate(opts: { cacheBaseDir?: string }): Promise<void> {
  const dir = path.join(cacheRoot(opts.cacheBaseDir), CSV_ROWS_NAMESPACE);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    if (isNotFound(cause)) {
      csvRowsHydrated = true;
      return;
    }
    throw cause;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    const fileHash = entry.slice(0, -".json".length);
    if (fileHash.length === 0) continue;
    try {
      const raw = await readJsonIfPresent<unknown>(filePath);
      if (raw === null) continue;
      const parsed = persistedCsvRowsSchema.safeParse(raw);
      if (!parsed.success) {
        logCsvRowsBulkHydrateSkip(filePath, "schema-invalid", parsed.error.message);
        continue;
      }
      const result: ParseResult = {
        rows: parsed.data.rows,
        columnMap: parsed.data.columnMap,
        unmapped: parsed.data.unmapped,
        errors: [],
      };
      setCsvRows(fileHash, result);
    } catch (cause) {
      logCsvRowsBulkHydrateSkip(filePath, "read-error", describeError(cause));
    }
  }
  csvRowsHydrated = true;
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
  const filePath = csvRowsCachePath(fileHash, baseDir);
  let raw: unknown;
  try {
    raw = await readJsonIfPresent<unknown>(filePath);
  } catch (cause) {
    logCsvRowsCacheSkip(filePath, "read-error", describeError(cause));
    return null;
  }
  if (raw === null) return null;
  const parsed = persistedCsvRowsSchema.safeParse(raw);
  if (!parsed.success) {
    logCsvRowsCacheSkip(filePath, "schema-invalid", parsed.error.message);
    return null;
  }
  return {
    rows: parsed.data.rows,
    columnMap: parsed.data.columnMap,
    unmapped: parsed.data.unmapped,
    errors: [],
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function logCsvRowsBulkHydrateSkip(
  filePath: string,
  reason: "schema-invalid" | "read-error",
  detail: string,
): void {
  console.error(
    JSON.stringify({
      scope: "csv-rows-hydrate",
      event: "skip",
      reason,
      filePath,
      detail,
    }),
  );
}

function logCsvRowsCacheSkip(
  filePath: string,
  reason: "schema-invalid" | "read-error",
  detail: string,
): void {
  console.error(
    JSON.stringify({
      scope: "ingest-csv",
      event: "skip",
      reason,
      filePath,
      detail,
    }),
  );
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
