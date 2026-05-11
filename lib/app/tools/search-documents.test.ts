import { describe, expect, it, vi } from "vitest";

import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { SearchHit, VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import type { Chunk } from "@/lib/domain/types";

import {
  createSearchDocumentsTool,
  searchDocumentsInputSchema,
  type SearchDocumentsResult,
} from "./search-documents";

const NOOP_OPTIONS = {
  toolCallId: "test-call",
  messages: [] as never[],
};

function makeChunk(
  id: string,
  vector: number[],
  text: string,
  sourceRef: Chunk["sourceRef"],
): Chunk {
  return {
    id,
    text,
    vector: Float32Array.from(vector),
    sourceRef,
  };
}

function makeEmbeddings(vector: number[]): {
  port: EmbeddingsPort;
  embed: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async (texts: string[]) => texts.map(() => vector));
  return { port: { embedTexts: embed }, embed };
}

function cosineScore(a: Float32Array, b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, aSq = 0, bSq = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aSq += av * av;
    bSq += bv * bv;
  }
  const denom = Math.sqrt(aSq) * Math.sqrt(bSq);
  return denom === 0 ? 0 : dot / denom;
}

function makeStore(chunks: Chunk[]): {
  store: VectorStorePort;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(
    (
      query: number[],
      k: number,
      filter?: (ref: Chunk["sourceRef"]) => boolean,
    ): SearchHit[] => {
      const filtered = filter
        ? chunks.filter((c) => filter(c.sourceRef))
        : chunks;
      return filtered.slice(0, k).map((chunk) => ({
        chunk,
        score: cosineScore(chunk.vector, query),
      }));
    },
  );
  const store: VectorStorePort = {
    async hydrate() {},
    has() {
      return true;
    },
    async upsert() {},
    search,
  };
  return { store, search };
}

async function execute(
  tool: ReturnType<typeof createSearchDocumentsTool>,
  input: unknown,
): Promise<SearchDocumentsResult> {
  const parsed = searchDocumentsInputSchema.parse(input);
  if (!tool.execute) throw new Error("tool.execute missing");
  return (await tool.execute(parsed, NOOP_OPTIONS)) as SearchDocumentsResult;
}

const FIXTURE_CHUNKS: Chunk[] = [
  makeChunk("a:csv-row:1", [1, 0, 0], "asphalt overlay", {
    type: "csv-row",
    file: "bids.csv",
    rowId: 1,
  }),
  makeChunk("b:pdf-page:7:0", [0.9, 0.1, 0], "Section 7.4 — asphalt", {
    type: "pdf-page",
    file: "plans.pdf",
    page: 7,
    chunkIndex: 0,
  }),
  makeChunk("c:pdf-page:9:0", [0, 1, 0], "Section 9.1 — drainage", {
    type: "pdf-page",
    file: "plans.pdf",
    page: 9,
    chunkIndex: 0,
  }),
];

describe("search_documents tool — input schema (strict)", () => {
  it("rejects unknown fields", () => {
    expect(
      searchDocumentsInputSchema.safeParse({ query: "x", weird: true }).success,
    ).toBe(false);
  });

  it("rejects empty / oversized queries", () => {
    expect(searchDocumentsInputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(
      searchDocumentsInputSchema.safeParse({ query: "a".repeat(2001) }).success,
    ).toBe(false);
  });

  it("rejects k above the documented maximum", () => {
    expect(
      searchDocumentsInputSchema.safeParse({ query: "x", k: 100 }).success,
    ).toBe(false);
  });

  it("rejects unknown sourceType", () => {
    expect(
      searchDocumentsInputSchema.safeParse({ query: "x", sourceType: "other" })
        .success,
    ).toBe(false);
  });
});

describe("search_documents tool — execute", () => {
  it("embeds the query once and passes the returned vector to store.search", async () => {
    const { port, embed } = makeEmbeddings([1, 0, 0]);
    const { store, search } = makeStore(FIXTURE_CHUNKS);
    const tool = createSearchDocumentsTool({ embeddings: port, store });
    await execute(tool, { query: "asphalt", k: 2 });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(["asphalt"]);
    expect(search).toHaveBeenCalledTimes(1);
    const [vec, k, filter] = search.mock.calls[0]!;
    expect(Array.from(vec)).toEqual([1, 0, 0]);
    expect(k).toBe(2);
    expect(filter).toBeUndefined();
  });

  it("returns chunks of both source types when no filter is set", async () => {
    const { port } = makeEmbeddings([1, 0, 0]);
    const { store } = makeStore(FIXTURE_CHUNKS);
    const tool = createSearchDocumentsTool({ embeddings: port, store });
    const result = await execute(tool, { query: "asphalt", k: 5 });
    const types = new Set(result.chunks.map((c) => c.sourceRef.type));
    expect(types.has("csv-row")).toBe(true);
    expect(types.has("pdf-page")).toBe(true);
    for (const chunk of result.chunks) {
      expect(Object.keys(chunk).sort()).toEqual(["score", "sourceRef", "text"]);
      expect(typeof chunk.score).toBe("number");
    }
  });

  it("filters to pdf-page when sourceType is provided", async () => {
    const { port } = makeEmbeddings([1, 0, 0]);
    const { store, search } = makeStore(FIXTURE_CHUNKS);
    const tool = createSearchDocumentsTool({ embeddings: port, store });
    const result = await execute(tool, {
      query: "asphalt",
      sourceType: "pdf-page",
    });
    for (const chunk of result.chunks) {
      expect(chunk.sourceRef.type).toBe("pdf-page");
    }
    const filterArg = search.mock.calls[0]?.[2];
    expect(typeof filterArg).toBe("function");
    expect(filterArg?.({ type: "csv-row", file: "x", rowId: 1 })).toBe(false);
    expect(
      filterArg?.({ type: "pdf-page", file: "x", page: 1, chunkIndex: 0 }),
    ).toBe(true);
  });

  it("returns empty chunks when the embeddings port produces an empty vector", async () => {
    const embed = vi.fn(async () => [[] as number[]]);
    const port: EmbeddingsPort = { embedTexts: embed };
    const { store, search } = makeStore(FIXTURE_CHUNKS);
    const tool = createSearchDocumentsTool({ embeddings: port, store });
    const result = await execute(tool, { query: "x" });
    expect(result.chunks).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("propagates embeddings errors", async () => {
    const port: EmbeddingsPort = {
      embedTexts: vi.fn(async () => {
        throw new Error("rate-limit");
      }),
    };
    const { store } = makeStore(FIXTURE_CHUNKS);
    const tool = createSearchDocumentsTool({ embeddings: port, store });
    await expect(execute(tool, { query: "x" })).rejects.toThrow(/rate-limit/);
  });

  it("computes a similarity score on the returned chunks", async () => {
    // Query identical to chunk-a's vector -> score ~ 1; chunk-c is orthogonal -> score 0.
    const { port } = makeEmbeddings([1, 0, 0]);
    const { store } = makeStore([FIXTURE_CHUNKS[0]!, FIXTURE_CHUNKS[2]!]);
    const tool = createSearchDocumentsTool({ embeddings: port, store });
    const result = await execute(tool, { query: "asphalt", k: 2 });
    const a = result.chunks.find((c) => c.sourceRef.type === "csv-row");
    const c = result.chunks.find(
      (c) => c.sourceRef.type === "pdf-page" && c.sourceRef.page === 9,
    );
    expect(a).toBeDefined();
    expect(c).toBeDefined();
    expect(a!.score).toBeCloseTo(1, 5);
    expect(c!.score).toBeCloseTo(0, 5);
  });
});

describe("search_documents tool — result shape (TechSpec SearchResult)", () => {
  it("returns exactly { chunks } with the documented chunk keys", async () => {
    const { port } = makeEmbeddings([1, 0, 0]);
    const { store } = makeStore(FIXTURE_CHUNKS);
    const tool = createSearchDocumentsTool({ embeddings: port, store });
    const result = await execute(tool, { query: "asphalt", k: 1 });
    expect(Object.keys(result)).toEqual(["chunks"]);
    const [chunk] = result.chunks;
    expect(chunk).toBeDefined();
    expect(Object.keys(chunk!).sort()).toEqual(["score", "sourceRef", "text"]);
  });
});
