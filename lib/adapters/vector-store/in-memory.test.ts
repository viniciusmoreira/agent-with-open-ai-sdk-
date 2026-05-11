import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Chunk, SourceRef } from "@/lib/domain/types";
import {
  embeddingsCacheDir,
  embeddingsCachePath,
} from "@/lib/adapters/cache/paths";
import { cosineSimilarity, InMemoryVectorStore } from "./in-memory";

const MODEL = "test-embedding-model";

function chunk(id: string, vec: number[], ref: SourceRef, text = id): Chunk {
  return {
    id,
    text,
    vector: Float32Array.from(vec),
    sourceRef: ref,
  };
}

const csvRef = (rowId: number): SourceRef => ({
  type: "csv-row",
  file: "bid.csv",
  rowId,
});
const pdfRef = (page: number): SourceRef => ({
  type: "pdf-page",
  file: "spec.pdf",
  page,
  chunkIndex: 0,
});

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const a = Float32Array.from([0.3, 0.4, 0.5]);
    const b = [0.3, 0.4, 0.5];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 0 when either vector is zero", () => {
    expect(cosineSimilarity(Float32Array.from([0, 0]), [1, 1])).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 1]), [0, 0])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity(Float32Array.from([]), [])).toBe(0);
  });
});

describe("InMemoryVectorStore upsert + search", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "vstore-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns inserted chunks ranked by cosine similarity", async () => {
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    const a = chunk("a", [1, 0, 0], csvRef(1));
    const b = chunk("b", [0.9, 0.1, 0], csvRef(2));
    const c = chunk("c", [0, 1, 0], csvRef(3));
    await store.upsert("hashA", [a, b, c]);

    const ranked = store.search([1, 0, 0], 3);
    expect(ranked.map((r) => r.chunk.id)).toEqual(["a", "b", "c"]);
  });

  it("limits results to k", async () => {
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    const chunks: Chunk[] = Array.from({ length: 10 }, (_, i) =>
      chunk(`c${i}`, [1, i / 10, 0], csvRef(i + 1)),
    );
    await store.upsert("hash10", chunks);
    const ranked = store.search([1, 0, 0], 3);
    expect(ranked).toHaveLength(3);
  });

  it("returns empty for k=0", async () => {
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.upsert("h", [chunk("a", [1, 0], csvRef(1))]);
    expect(store.search([1, 0], 0)).toEqual([]);
  });

  it("filters by SourceRef predicate", async () => {
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    const csv = chunk("csv1", [1, 0, 0], csvRef(1));
    const pdf = chunk("pdf1", [1, 0, 0], pdfRef(1));
    await store.upsert("mixed", [csv, pdf]);
    const onlyPdf = store.search([1, 0, 0], 5, (r) => r.type === "pdf-page");
    expect(onlyPdf.map((h) => h.chunk.id)).toEqual(["pdf1"]);
  });

  it("returns empty when the query vector is zero", async () => {
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.upsert("h", [chunk("a", [1, 1, 1], csvRef(1))]);
    expect(store.search([0, 0, 0], 5)).toEqual([]);
  });
});

describe("InMemoryVectorStore.has", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "vstore-has-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns false for unseen hashes and true after upsert", async () => {
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    expect(store.has("missing")).toBe(false);
    await store.upsert("present", [chunk("a", [1, 0], csvRef(1))]);
    expect(store.has("present")).toBe(true);
    expect(store.has("other")).toBe(false);
  });
});

describe("InMemoryVectorStore cache write-through", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "vstore-cache-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("writes a <hash>-<model>.json file that round-trips through hydrate", async () => {
    const writer = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    const original = chunk("c1", [0.1, 0.2, 0.3], pdfRef(7), "specification body");
    await writer.upsert("fileX", [original]);

    const expectedPath = embeddingsCachePath("fileX", MODEL, workDir);
    const raw = await readFile(expectedPath, "utf8");
    const parsed = JSON.parse(raw) as {
      fileHash: string;
      model: string;
      chunks: Array<{ vector: number[] }>;
    };
    expect(parsed.fileHash).toBe("fileX");
    expect(parsed.model).toBe(MODEL);
    expect(parsed.chunks[0]?.vector).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);

    const reader = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await reader.hydrate();
    expect(reader.has("fileX")).toBe(true);
    const hits = reader.search([0.1, 0.2, 0.3], 1);
    expect(hits[0]?.chunk.id).toBe("c1");
    expect(hits[0]?.chunk.text).toBe("specification body");
    expect(hits[0]?.chunk.vector).toBeInstanceOf(Float32Array);
  });
});

describe("InMemoryVectorStore.hydrate", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "vstore-hydrate-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function seed(fileHash: string, chunks: Chunk[]) {
    const dir = embeddingsCacheDir(workDir);
    await mkdir(dir, { recursive: true });
    const target = embeddingsCachePath(fileHash, MODEL, workDir);
    const payload = {
      fileHash,
      model: MODEL,
      chunks: chunks.map((c) => ({
        id: c.id,
        text: c.text,
        vector: Array.from(c.vector),
        sourceRef: c.sourceRef,
      })),
    };
    await writeFile(target, JSON.stringify(payload), "utf8");
  }

  it("populates the store from a fixture cache directory containing two JSON files", async () => {
    await seed("h1", [chunk("h1-c1", [1, 0, 0], csvRef(1))]);
    await seed("h2", [
      chunk("h2-c1", [0, 1, 0], pdfRef(1)),
      chunk("h2-c2", [0, 0, 1], pdfRef(2)),
    ]);
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.hydrate();
    expect(store.has("h1")).toBe(true);
    expect(store.has("h2")).toBe(true);
    expect(store.search([1, 0, 0], 5)).toHaveLength(3);
  });

  it("is idempotent across calls and does not double-insert chunks", async () => {
    await seed("h1", [chunk("h1-c1", [1, 0, 0], csvRef(1))]);
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.hydrate();
    await store.hydrate();
    await store.hydrate();
    const hits = store.search([1, 0, 0], 100);
    expect(hits).toHaveLength(1);
  });

  it("returns immediately when the cache directory is missing", async () => {
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: path.join(workDir, "does-not-exist"),
    });
    await expect(store.hydrate()).resolves.toBeUndefined();
    expect(store.search([1, 0, 0], 5)).toEqual([]);
  });

  it("ignores .tmp files left by interrupted writes", async () => {
    const dir = embeddingsCacheDir(workDir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `interrupted-${MODEL}.json.abc123.tmp`),
      JSON.stringify({ fileHash: "x", model: MODEL, chunks: [] }),
      "utf8",
    );
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.hydrate();
    expect(store.has("x")).toBe(false);
  });

  it("ignores cache files written under a different embedding model", async () => {
    const dir = embeddingsCacheDir(workDir);
    await mkdir(dir, { recursive: true });
    const stranger = path.join(dir, "h1-other-model.json");
    await writeFile(
      stranger,
      JSON.stringify({
        fileHash: "h1",
        model: "other-model",
        chunks: [
          {
            id: "x",
            text: "x",
            vector: [1, 0],
            sourceRef: { type: "csv-row", file: "f", rowId: 1 },
          },
        ],
      }),
      "utf8",
    );
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.hydrate();
    expect(store.has("h1")).toBe(false);
  });

  it("dedupes concurrent hydrate() calls into one disk scan", async () => {
    await seed("hc", [chunk("hc-1", [1, 0], csvRef(1))]);
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await Promise.all([store.hydrate(), store.hydrate(), store.hydrate()]);
    expect(store.search([1, 0], 100)).toHaveLength(1);
  });
});

describe("InMemoryVectorStore.hydrate defensive validation", () => {
  let workDir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "vstore-defensive-"));
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeRaw(name: string, body: string) {
    const dir = embeddingsCacheDir(workDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), body, "utf8");
  }

  it("skips malformed JSON without throwing", async () => {
    await writeRaw(`bad-${MODEL}.json`, "{not valid json");
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await expect(store.hydrate()).resolves.toBeUndefined();
    expect(store.has("bad")).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as {
      scope: string;
      reason: string;
    };
    expect(logged.scope).toBe("vector-store-hydrate");
    expect(logged.reason).toBe("read-error");
  });

  it("skips files whose payload fails schema validation", async () => {
    await writeRaw(
      `drifted-${MODEL}.json`,
      JSON.stringify({
        fileHash: "drifted",
        model: MODEL,
        chunks: [
          {
            id: "c1",
            text: "hello",
            vector: [0.1, 0.2],
            // sourceRef intentionally missing required `rowId`
            sourceRef: { type: "csv-row", file: "f.csv" },
          },
        ],
      }),
    );
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.hydrate();
    expect(store.has("drifted")).toBe(false);
    const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as {
      reason: string;
    };
    expect(logged.reason).toBe("schema-invalid");
  });

  it("skips envelopes whose embedded model disagrees with the active model", async () => {
    await writeRaw(
      `wrong-${MODEL}.json`,
      JSON.stringify({
        fileHash: "wrong",
        model: "some-other-model",
        chunks: [
          {
            id: "c1",
            text: "hello",
            vector: [0.1, 0.2],
            sourceRef: { type: "csv-row", file: "f.csv", rowId: 1 },
          },
        ],
      }),
    );
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.hydrate();
    expect(store.has("wrong")).toBe(false);
    const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as {
      reason: string;
    };
    expect(logged.reason).toBe("model-mismatch");
  });

  it("loads valid files even when sibling files are corrupt", async () => {
    await writeRaw(`broken-${MODEL}.json`, "}{");
    await writeRaw(
      `good-${MODEL}.json`,
      JSON.stringify({
        fileHash: "good",
        model: MODEL,
        chunks: [
          {
            id: "g1",
            text: "good chunk",
            vector: [1, 0, 0],
            sourceRef: { type: "csv-row", file: "f.csv", rowId: 1 },
          },
        ],
      }),
    );
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.hydrate();
    expect(store.has("broken")).toBe(false);
    expect(store.has("good")).toBe(true);
    const hits = store.search([1, 0, 0], 5);
    expect(hits.map((h) => h.chunk.id)).toEqual(["g1"]);
  });
});

describe("InMemoryVectorStore singleton export", () => {
  it("exports a module-level singleton instance", async () => {
    const mod = await import("./in-memory");
    expect(mod.store).toBeInstanceOf(InMemoryVectorStore);
    const again = await import("./in-memory");
    expect(again.store).toBe(mod.store);
  });
});

describe("InMemoryVectorStore.upsert overwrite", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "vstore-overwrite-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("replaces previously stored chunks for the same fileHash", async () => {
    const store = new InMemoryVectorStore({
      embeddingModel: MODEL,
      cacheBaseDir: workDir,
    });
    await store.upsert("hash", [chunk("old", [1, 0], csvRef(1))]);
    await store.upsert("hash", [
      chunk("new1", [1, 0], csvRef(2)),
      chunk("new2", [0, 1], csvRef(3)),
    ]);
    const hits = store.search([1, 0], 10);
    expect(hits.map((h) => h.chunk.id).sort()).toEqual(["new1", "new2"]);
    const entries = await readdir(embeddingsCacheDir(workDir));
    expect(entries).toEqual([`hash-${MODEL}.json`]);
  });
});
