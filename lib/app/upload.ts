import { createHash } from "node:crypto";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";

import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";

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
  /** Called instead of `setImmediate`. Test seam so tests can await dispatch. */
  dispatch?: (run: () => Promise<void>) => void;
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
  const tmpDir = deps.tmpDir ?? path.join(process.cwd(), "tmp");
  const dispatch = deps.dispatch ?? defaultDispatch;

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
    return jsonOk({ fileHash, cached: true });
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

function defaultDispatch(run: () => Promise<void>): void {
  setImmediate(() => {
    void run();
  });
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
