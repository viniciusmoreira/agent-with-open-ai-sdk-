import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Chunk } from "@/lib/domain/types";
import type { SourceFilter, VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import { readJsonIfPresent, writeJsonAtomic } from "@/lib/adapters/cache/atomic-json";
import {
  embeddingsCacheDir,
  embeddingsCachePath,
} from "@/lib/adapters/cache/paths";
import { getEnv } from "@/lib/config/env";

const sourceRefSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("csv-row"),
      file: z.string().min(1),
      rowId: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("pdf-page"),
      file: z.string().min(1),
      page: z.number().int().nonnegative(),
      chunkIndex: z.number().int().nonnegative(),
    })
    .strict(),
]);

const persistedChunkSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    vector: z.array(z.number()),
    sourceRef: sourceRefSchema,
  })
  .strict();

const cacheFileSchema = z
  .object({
    fileHash: z.string().min(1),
    model: z.string().min(1),
    chunks: z.array(persistedChunkSchema),
  })
  .strict();

type PersistedChunk = z.infer<typeof persistedChunkSchema>;
type CacheFile = z.infer<typeof cacheFileSchema>;

export type InMemoryVectorStoreOptions = {
  embeddingModel?: string;
  cacheBaseDir?: string;
};

export class InMemoryVectorStore implements VectorStorePort {
  private readonly byFileHash = new Map<string, Chunk[]>();
  private readonly injectedModel: string | undefined;
  private readonly cacheBaseDir: string | undefined;
  private hydrated = false;
  private hydrating: Promise<void> | null = null;

  constructor(options: InMemoryVectorStoreOptions = {}) {
    this.injectedModel = options.embeddingModel;
    this.cacheBaseDir = options.cacheBaseDir;
  }

  hydrate(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    if (this.hydrating) return this.hydrating;
    this.hydrating = this.runHydrate().finally(() => {
      this.hydrating = null;
    });
    return this.hydrating;
  }

  has(fileHash: string): boolean {
    return this.byFileHash.has(fileHash);
  }

  async upsert(fileHash: string, chunks: Chunk[]): Promise<void> {
    const stored = chunks.map((c) => ({
      id: c.id,
      text: c.text,
      vector: ensureFloat32(c.vector),
      sourceRef: c.sourceRef,
    }));
    this.byFileHash.set(fileHash, stored);
    await this.writeCache(fileHash, stored);
  }

  search(queryVector: number[], k: number, filter?: SourceFilter): Chunk[] {
    if (k <= 0 || queryVector.length === 0) return [];
    const queryNorm = vectorNorm(queryVector);
    if (queryNorm === 0) return [];
    const scored: Array<{ chunk: Chunk; score: number }> = [];
    for (const chunks of this.byFileHash.values()) {
      for (const chunk of chunks) {
        if (filter && !filter(chunk.sourceRef)) continue;
        const score = cosineSimilarity(chunk.vector, queryVector, queryNorm);
        scored.push({ chunk, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.chunk);
  }

  private get model(): string {
    return this.injectedModel ?? getEnv().EMBEDDING_MODEL;
  }

  private async runHydrate(): Promise<void> {
    const dir = embeddingsCacheDir(this.cacheBaseDir);
    const suffix = `-${this.model}.json`;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (cause) {
      if (isNotFound(cause)) {
        this.hydrated = true;
        return;
      }
      throw cause;
    }
    for (const entry of entries) {
      if (!entry.endsWith(suffix)) continue;
      const filePath = path.join(dir, entry);
      try {
        const raw = await readJsonIfPresent<unknown>(filePath);
        if (raw === null) continue;
        const parsed = cacheFileSchema.safeParse(raw);
        if (!parsed.success) {
          logHydrateSkip(filePath, "schema-invalid", parsed.error.message);
          continue;
        }
        if (parsed.data.model !== this.model) {
          logHydrateSkip(
            filePath,
            "model-mismatch",
            `expected ${this.model}, got ${parsed.data.model}`,
          );
          continue;
        }
        const chunks = parsed.data.chunks.map(toChunk);
        this.byFileHash.set(parsed.data.fileHash, chunks);
      } catch (cause) {
        logHydrateSkip(filePath, "read-error", describeError(cause));
      }
    }
    this.hydrated = true;
  }

  private async writeCache(fileHash: string, chunks: Chunk[]): Promise<void> {
    const target = embeddingsCachePath(fileHash, this.model, this.cacheBaseDir);
    const payload: CacheFile = {
      fileHash,
      model: this.model,
      chunks: chunks.map((c) => ({
        id: c.id,
        text: c.text,
        vector: Array.from(c.vector),
        sourceRef: c.sourceRef,
      })),
    };
    await writeJsonAtomic(target, payload);
  }
}

function toChunk(p: PersistedChunk): Chunk {
  return {
    id: p.id,
    text: p.text,
    vector: Float32Array.from(p.vector),
    sourceRef: p.sourceRef,
  };
}

function ensureFloat32(v: Float32Array): Float32Array {
  return v instanceof Float32Array ? v : Float32Array.from(v as ArrayLike<number>);
}

function vectorNorm(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

export function cosineSimilarity(
  a: Float32Array,
  b: number[],
  precomputedBNorm?: number,
): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let aSq = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aSq += av * av;
  }
  const aNorm = Math.sqrt(aSq);
  const bNorm = precomputedBNorm ?? vectorNorm(b);
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (aNorm * bNorm);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function logHydrateSkip(
  filePath: string,
  reason: "schema-invalid" | "model-mismatch" | "read-error",
  detail: string,
): void {
  console.error(
    JSON.stringify({
      scope: "vector-store-hydrate",
      event: "skip",
      reason,
      filePath,
      detail,
    }),
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const store = new InMemoryVectorStore();
