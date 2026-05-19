import { createHash } from "node:crypto";
import {
  mkdir as fsMkdir,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import path from "node:path";

import { getEnv } from "@/lib/config/env";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";

import { rehydrateCsvRowsFromDisk } from "./ingest-csv";

export type UploadFileKind = "csv" | "pdf";

export type UploadIngestFn = (
  filePath: string,
  fileHash: string,
) => Promise<void>;

export type UploadDeps = {
  store: VectorStorePort;
  ingestCsv: UploadIngestFn;
  ingestPdf: UploadIngestFn;
  maxBytes: number;
  tmpDir?: string;
  mkdir?: (dir: string, opts: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (filePath: string, data: Uint8Array) => Promise<void>;
  /**
   * Removes the staged temp file once ingestion settles. Defaults to
   * `fs.unlink`; tests override it to assert cleanup without touching disk.
   */
  unlink?: (filePath: string) => Promise<void>;
  /**
   * Called instead of the module-level bounded dispatcher. Test seam so tests
   * can await dispatch or assert queueing without spinning up real timers.
   */
  dispatch?: (run: () => Promise<void>) => void;
  /**
   * Reloads the in-memory CSV row cache from disk for a given fileHash.
   * Returns true on success, false when the on-disk cache is missing so the
   * caller can fall through to a full ingestion. Test seam.
   */
  rehydrateCsvRows?: (fileHash: string) => Promise<boolean>;
};

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const TEXT_SNIFF_BYTES = 4096;
const PRINTABLE_RATIO_THRESHOLD = 0.9;

export function detectFileKind(bytes: Uint8Array): UploadFileKind | null {
  if (bytesStartWith(bytes, PDF_MAGIC)) return "pdf";
  if (looksLikeCsvText(bytes)) return "csv";
  return null;
}

export async function handleUpload(
  request: Request,
  deps: UploadDeps,
): Promise<Response> {
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const mkdir = deps.mkdir ?? defaultMkdir;
  const unlink = deps.unlink ?? defaultUnlink;
  const tmpDir = deps.tmpDir ?? path.join(process.cwd(), "tmp");
  const dispatch = deps.dispatch ?? defaultDispatch;

  const advertised = parseContentLength(request.headers.get("content-length"));
  if (advertised !== null && advertised > deps.maxBytes) {
    return jsonError(413, `Upload exceeds the ${deps.maxBytes}-byte limit`);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "Request body must be multipart/form-data");
  }

  const field = form.get("file");
  if (!field || typeof field === "string") {
    return jsonError(400, "Missing file field in upload");
  }
  const file = field as Blob & { name?: string };
  if (file.size === 0) {
    return jsonError(400, "Uploaded file is empty");
  }
  if (file.size > deps.maxBytes) {
    return jsonError(413, `Upload exceeds the ${deps.maxBytes}-byte limit`);
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  if (buffer.byteLength > deps.maxBytes) {
    return jsonError(413, `Upload exceeds the ${deps.maxBytes}-byte limit`);
  }

  const kind = detectFileKind(buffer);
  if (kind === null) {
    return jsonError(
      400,
      "Unsupported file type — magic bytes do not match CSV or PDF",
    );
  }

  const fileHash = sha256Hex(buffer);
  if (deps.store.has(fileHash)) {
    if (kind === "csv") {
      const rehydrate = deps.rehydrateCsvRows ?? rehydrateCsvRowsFromDisk;
      const ok = await rehydrate(fileHash);
      if (ok) {
        return jsonOk({ fileHash, cached: true });
      }
      // Embeddings exist on disk but the row cache does not — fall through to
      // the full ingestion path so query_bids / find_outliers can answer.
    } else {
      return jsonOk({ fileHash, cached: true });
    }
  }

  const baseName = sanitizeFilename(file.name ?? `${kind}-upload`);
  const targetPath = path.join(tmpDir, `${fileHash}-${baseName}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(targetPath, buffer);
  } catch (cause) {
    return jsonError(
      500,
      `Failed to persist upload: ${describeError(cause)}`,
    );
  }

  const runner = kind === "csv" ? deps.ingestCsv : deps.ingestPdf;
  dispatch(async () => {
    try {
      await runner(targetPath, fileHash);
    } catch (err) {
      console.error(
        JSON.stringify({
          scope: "upload-dispatch",
          message: "ingestion failed",
          kind,
          fileHash,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      try {
        await unlink(targetPath);
      } catch (cleanupErr) {
        if (!isMissingFileError(cleanupErr)) {
          console.error(
            JSON.stringify({
              scope: "upload-dispatch",
              message: "temp cleanup failed",
              kind,
              fileHash,
              error:
                cleanupErr instanceof Error
                  ? cleanupErr.message
                  : String(cleanupErr),
            }),
          );
        }
      }
    }
  });

  return jsonOk({ fileHash, cached: false });
}

function bytesStartWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function looksLikeCsvText(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, TEXT_SNIFF_BYTES);
  if (limit === 0) return false;
  let printable = 0;
  let sawComma = false;
  let sawNewline = false;
  for (let i = 0; i < limit; i++) {
    const b = bytes[i]!;
    if (b === 0x00) return false;
    if (b === 0x2c) sawComma = true;
    if (b === 0x0a || b === 0x0d) {
      sawNewline = true;
      printable++;
      continue;
    }
    if (b === 0x09 || (b >= 0x20 && b <= 0x7e)) {
      printable++;
      continue;
    }
    if (b >= 0x80) {
      // Allow extended bytes (UTF-8 continuation) as printable for the ratio
      printable++;
    }
  }
  const ratio = printable / limit;
  if (ratio < PRINTABLE_RATIO_THRESHOLD) return false;
  return sawComma || sawNewline;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (cleaned.length === 0) return "upload";
  return cleaned.slice(0, 100);
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Creates a dispatcher that runs at most `limit` jobs concurrently. Excess
 * jobs queue in FIFO order; each completion drains the next slot.
 *
 * The ingestion pipeline (Vision OCR + embeddings) is memory- and quota-heavy
 * and assumes a single-user workload. Bounding concurrency keeps the in-memory
 * vector store and OpenAI rate budget within the envelope ADR-004/005 trade for.
 */
export function createBoundedDispatch(
  limit: number,
): (run: () => Promise<void>) => void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `createBoundedDispatch requires a positive integer limit, got ${limit}`,
    );
  }
  let active = 0;
  const queue: Array<() => Promise<void>> = [];
  const drain = (): void => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift()!;
      active++;
      setImmediate(() => {
        next()
          .catch(() => {
            // run() already wraps the ingestion to log + swallow errors; this
            // catch is defensive against future callers that pass a rejecting
            // task so we never leak an unhandled rejection from the queue.
          })
          .finally(() => {
            active--;
            drain();
          });
      });
    }
  };
  return (run) => {
    queue.push(run);
    drain();
  };
}

let cachedDefaultDispatch: ((run: () => Promise<void>) => void) | undefined;

function defaultDispatch(run: () => Promise<void>): void {
  if (!cachedDefaultDispatch) {
    cachedDefaultDispatch = createBoundedDispatch(
      getEnv().UPLOAD_INGEST_CONCURRENCY,
    );
  }
  cachedDefaultDispatch(run);
}

function defaultMkdir(
  dir: string,
  opts: { recursive: boolean },
): Promise<unknown> {
  return fsMkdir(dir, opts);
}

function defaultWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  return fsWriteFile(filePath, data);
}

function defaultUnlink(filePath: string): Promise<void> {
  return fsUnlink(filePath);
}

function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
