import "server-only";
import { createHash } from "node:crypto";
import { APIError } from "openai";
import { pdfToPng } from "pdf-to-png-converter";
import { z } from "zod";

import { readJsonIfPresent, writeJsonAtomic } from "@/lib/adapters/cache/atomic-json";
import { ocrCachePath } from "@/lib/adapters/cache/paths";
import { getOpenAIClient } from "@/lib/adapters/openai/client";
import { getEnv } from "@/lib/config/env";
import type { DomainError } from "@/lib/domain/types";
import type {
  OcrPageInput,
  OcrPageResult,
  OcrPort,
} from "@/lib/domain/ports/ocr-port";

export const VISION_PROMPT =
  'Extract all readable text from this construction document page. Preserve table structure with simple delimiters. If a region is illegible, output "[illegible]".';

const DEFAULT_VIEWPORT_SCALE = 2.0;
const RETRY_DELAYS_MS = [500, 1000, 2000] as const;

const cachedOcrSchema = z
  .object({
    pageImageHash: z.string().min(1),
    model: z.string().min(1),
    text: z.string(),
  })
  .strict();

export type CachedOcrPayload = z.infer<typeof cachedOcrSchema>;

export type VisionOcrOptions = {
  /** Override the Vision model (defaults to the env-configured `VISION_OCR_MODEL`). */
  model?: string;
  /** Cache root used by `ocrCachePath` (defaults to `process.cwd()`). */
  cacheBase?: string;
  /** Override the `getOpenAIClient` instance — used by unit tests. */
  client?: ReturnType<typeof getOpenAIClient>;
  /** Custom retry sleep — used to bypass real timers in tests. */
  sleep?: (ms: number) => Promise<void>;
};

export class OcrAdapterError extends Error {
  readonly domainError: DomainError;
  constructor(domainError: DomainError) {
    super(domainError.message);
    this.name = "OcrAdapterError";
    this.domainError = domainError;
  }
}

export function createVisionOcr(options: VisionOcrOptions = {}): OcrPort {
  const model = options.model ?? getEnv().VISION_OCR_MODEL;
  const sleep = options.sleep ?? defaultSleep;
  return {
    async extractPageText(input: OcrPageInput): Promise<OcrPageResult> {
      const hash = sha256(input.pageImage);
      const cachePath = ocrCachePath(hash, options.cacheBase);

      const cached = await readCachedOcr(cachePath, model);
      if (cached) return { text: cached.text, cached: true };

      const text = await callVision({
        client: options.client ?? getOpenAIClient(),
        model,
        pageImage: input.pageImage,
        page: input.page,
        sleep,
      });

      await writeJsonAtomic<CachedOcrPayload>(cachePath, {
        pageImageHash: hash,
        model,
        text,
      });
      return { text, cached: false };
    },
  };
}

export type PdfToPngFn = typeof pdfToPng;

export type RasterizeOptions = {
  /** Render scale forwarded to `pdf-to-png-converter`. Defaults to 2x. */
  viewportScale?: number;
  /** Source file label attached to thrown errors. */
  file?: string;
  /** Replace the rasterizer (used by tests). */
  pdfToPng?: PdfToPngFn;
};

export async function rasterizePdfPage(
  pdf: Uint8Array,
  page: number,
  options: RasterizeOptions = {},
): Promise<Uint8Array> {
  let out: Map<number, Uint8Array>;
  try {
    out = await rasterizePdfPages(pdf, [page], options);
  } catch (err) {
    if (err instanceof OcrAdapterError && err.domainError.kind === "pdf") {
      throw new OcrAdapterError({ ...err.domainError, page });
    }
    throw err;
  }
  const png = out.get(page);
  if (!png) {
    throw new OcrAdapterError({
      kind: "pdf",
      message: `rasterizer returned no output for page ${page}`,
      page,
      ...(options.file !== undefined ? { file: options.file } : {}),
    });
  }
  return png;
}

export async function rasterizePdfPages(
  pdf: Uint8Array,
  pages: number[],
  options: RasterizeOptions = {},
): Promise<Map<number, Uint8Array>> {
  const result = new Map<number, Uint8Array>();
  if (pages.length === 0) return result;
  const rasterize = options.pdfToPng ?? pdfToPng;
  try {
    const out = await rasterize(cloneBytes(pdf).buffer as ArrayBuffer, {
      pagesToProcess: pages,
      viewportScale: options.viewportScale ?? DEFAULT_VIEWPORT_SCALE,
      strictPagesToProcess: true,
      verbosityLevel: 0,
    });
    for (const item of out) {
      result.set(item.pageNumber, new Uint8Array(item.content));
    }
    return result;
  } catch (cause) {
    if (cause instanceof OcrAdapterError) throw cause;
    throw new OcrAdapterError({
      kind: "pdf",
      message: `failed to rasterize pages [${pages.join(", ")}]: ${describe(cause)}`,
      cause,
      ...(options.file !== undefined ? { file: options.file } : {}),
    });
  }
}

type CallVisionParams = {
  client: ReturnType<typeof getOpenAIClient>;
  model: string;
  pageImage: Uint8Array;
  page: number;
  sleep: (ms: number) => Promise<void>;
};

async function callVision(params: CallVisionParams): Promise<string> {
  const dataUrl = `data:image/png;base64,${Buffer.from(params.pageImage).toString("base64")}`;
  try {
    const res = await withRetry(
      () =>
        params.client.chat.completions.create({
          model: params.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: VISION_PROMPT },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      params.sleep,
    );
    const text = res.choices[0]?.message?.content;
    if (typeof text !== "string") {
      throw new OcrAdapterError({
        kind: "ocr",
        message: `vision response missing text content on page ${params.page}`,
        page: params.page,
      });
    }
    return text;
  } catch (cause) {
    if (cause instanceof OcrAdapterError) throw cause;
    throw new OcrAdapterError({
      kind: "ocr",
      message: `vision OCR failed on page ${params.page}: ${describe(cause)}`,
      page: params.page,
      cause,
    });
  }
}

async function withRetry<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  const status = err.status;
  if (typeof status !== "number") return false;
  return status === 429 || (status >= 500 && status < 600);
}

async function readCachedOcr(
  cachePath: string,
  expectedModel: string,
): Promise<CachedOcrPayload | null> {
  try {
    const raw = await readJsonIfPresent<unknown>(cachePath);
    if (raw === null) return null;
    const parsed = cachedOcrSchema.safeParse(raw);
    if (!parsed.success) {
      logOcrCacheSkip(cachePath, "schema-invalid", parsed.error.message);
      return null;
    }
    if (parsed.data.model !== expectedModel) {
      logOcrCacheSkip(
        cachePath,
        "model-mismatch",
        `expected ${expectedModel}, got ${parsed.data.model}`,
      );
      return null;
    }
    return parsed.data;
  } catch (cause) {
    logOcrCacheSkip(cachePath, "read-error", describe(cause));
    return null;
  }
}

function logOcrCacheSkip(
  filePath: string,
  reason: "schema-invalid" | "model-mismatch" | "read-error",
  detail: string,
): void {
  console.error(
    JSON.stringify({
      scope: "ocr-cache",
      event: "skip",
      reason,
      filePath,
      detail,
    }),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneBytes(src: Uint8Array): Uint8Array {
  const copy = new Uint8Array(src.byteLength);
  copy.set(src);
  return copy;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "unknown error";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
