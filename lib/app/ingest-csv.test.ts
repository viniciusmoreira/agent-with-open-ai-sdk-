import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeJsonAtomic } from "@/lib/adapters/cache/atomic-json";
import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import type { Chunk, IngestEvent, ParseResult } from "@/lib/domain/types";

import { clearCsvRowCache, getCsvRows } from "./csv-row-cache";
import {
  csvRowsCachePath,
  ingestCsv,
  rehydrateCsvRowsFromDisk,
  type IngestCsvDeps,
  type LoadCsvRowsFn,
  type PersistCsvRowsFn,
} from "./ingest-csv";

type Recorded = IngestEvent[];

type StoreState = {
  store: VectorStorePort;
  upserts: Array<{ fileHash: string; chunks: Chunk[] }>;
  setHas: (value: boolean) => void;
};

function makeStore(initialHas = false): StoreState {
  let presentHash = initialHas;
  const upserts: Array<{ fileHash: string; chunks: Chunk[] }> = [];
  const store: VectorStorePort = {
    async hydrate() {},
    has() {
      return presentHash;
    },
    async upsert(fileHash: string, chunks: Chunk[]) {
      upserts.push({ fileHash, chunks });
      presentHash = true;
    },
    search() {
      return [];
    },
  };
  return {
    store,
    upserts,
    setHas: (value: boolean) => {
      presentHash = value;
    },
  };
}

function makeEmbeddings(): { port: EmbeddingsPort; embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map((_t, idx) => [idx + 1, (idx + 1) * 0.5]),
  );
  return { port: { embedTexts: embed }, embed };
}

function makeDeps(overrides: Partial<IngestCsvDeps> = {}): {
  deps: IngestCsvDeps;
  store: StoreState;
  embed: ReturnType<typeof vi.fn>;
  persistCsvRows: ReturnType<typeof vi.fn>;
  loadCsvRows: ReturnType<typeof vi.fn>;
} {
  const store = makeStore();
  const { port, embed } = makeEmbeddings();
  const persistCsvRows = vi.fn<PersistCsvRowsFn>(async () => {});
  const loadCsvRows = vi.fn<LoadCsvRowsFn>(async () => null);
  const deps: IngestCsvDeps = {
    embeddings: port,
    store: store.store,
    readFile: async () => "",
    statFile: async () => ({ size: 0 }),
    parse: () => ({ rows: [], columnMap: emptyColumnMap(), unmapped: [], errors: [] }),
    persistCsvRows,
    loadCsvRows,
    ...overrides,
  };
  return { deps, store, embed, persistCsvRows, loadCsvRows };
}

function emptyColumnMap() {
  return {
    projectId: "PROJ_ID",
    itemNo: "ITEM_NO",
    itemDesc: "ITEM_DESC",
    unit: "UNIT",
    qty: "QTY",
    unitPrice: "UNIT_PR",
    bidder: "BIDDER",
  };
}

function makeParseResult(
  rowCount: number,
  options: { unmapped?: string[]; errors?: ParseResult["errors"] } = {},
): ParseResult {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    rowId: i + 1,
    projectId: "P1",
    itemNo: `1010${i}`,
    itemDesc: `desc-${i + 1}`,
    unit: "LS",
    qty: 1,
    bidder: "ACME",
    unitPrice: 100 + i,
    extAmt: 100 + i,
    raw: {},
  }));
  return {
    rows,
    columnMap: emptyColumnMap(),
    unmapped: options.unmapped ?? [],
    errors: options.errors ?? [],
  };
}

afterEach(() => {
  clearCsvRowCache();
  vi.restoreAllMocks();
});

describe("ingestCsv", () => {
  it("parses, embeds, upserts, and emits ordered events on happy path", async () => {
    const events: Recorded = [];
    const parsed = makeParseResult(3, { unmapped: ["EXTRA_COL"] });
    const { deps, store, embed } = makeDeps({
      readFile: async () => "csv-text",
      statFile: async () => ({ size: 42 }),
      parse: () => parsed,
    });

    await ingestCsv("/tmp/bids.csv", "hash-1", (e) => events.push(e), deps);

    expect(events.map((e) => e.kind)).toEqual([
      "file-start",
      "csv-progress",
      "file-done",
    ]);

    const start = events[0]!;
    expect(start).toMatchObject({ kind: "file-start", file: "bids.csv", sizeBytes: 42 });
    const progress = events[1]!;
    expect(progress).toMatchObject({ kind: "csv-progress", file: "bids.csv", rows: 3 });
    const done = events[2]!;
    expect(done).toMatchObject({
      kind: "file-done",
      file: "bids.csv",
      chunks: 3,
      cached: false,
      unmapped: ["EXTRA_COL"],
    });

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(["desc-1", "desc-2", "desc-3"]);

    expect(store.upserts).toHaveLength(1);
    const upserted = store.upserts[0]!;
    expect(upserted.fileHash).toBe("hash-1");
    expect(upserted.chunks).toHaveLength(3);
    for (const [idx, chunk] of upserted.chunks.entries()) {
      expect(chunk.sourceRef).toEqual({
        type: "csv-row",
        file: "bids.csv",
        rowId: idx + 1,
      });
      expect(chunk.id).toBe(`hash-1:csv-row:${idx + 1}`);
      expect(chunk.text).toBe(`desc-${idx + 1}`);
      expect(chunk.vector).toBeInstanceOf(Float32Array);
      expect(Array.from(chunk.vector)).toEqual([idx + 1, (idx + 1) * 0.5]);
    }

    expect(getCsvRows("hash-1")?.rows).toHaveLength(3);
  });

  it("embeds only itemDesc strings, not concatenated row text", async () => {
    const parsed = makeParseResult(2);
    const { deps, embed } = makeDeps({
      readFile: async () => "csv-text",
      statFile: async () => ({ size: 1 }),
      parse: () => parsed,
    });

    await ingestCsv("/tmp/x.csv", "hash-x", () => {}, deps);

    expect(embed).toHaveBeenCalledTimes(1);
    const [arg] = embed.mock.calls[0]!;
    expect(arg).toEqual(["desc-1", "desc-2"]);
    for (const text of arg as string[]) {
      expect(text).not.toContain("ACME");
      expect(text).not.toContain("LS");
    }
  });

  it("short-circuits with cached:true and skips embedding when store.has(fileHash) and the row cache is on disk", async () => {
    const events: Recorded = [];
    const store = makeStore(true);
    const { port, embed } = makeEmbeddings();
    const parse = vi.fn(() => makeParseResult(2));
    const readFile = vi.fn(async () => "csv-text");
    const persisted = makeParseResult(2);
    const loadCsvRows = vi.fn<LoadCsvRowsFn>(async () => persisted);
    const persistCsvRows = vi.fn<PersistCsvRowsFn>(async () => {});

    await ingestCsv(
      "/tmp/cached.csv",
      "hash-cached",
      (e) => events.push(e),
      {
        embeddings: port,
        store: store.store,
        readFile,
        statFile: async () => ({ size: 7 }),
        parse,
        loadCsvRows,
        persistCsvRows,
      },
    );

    expect(events.map((e) => e.kind)).toEqual(["file-start", "file-done"]);
    expect(events[1]).toMatchObject({
      kind: "file-done",
      file: "cached.csv",
      chunks: 0,
      cached: true,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(store.upserts).toHaveLength(0);
    expect(loadCsvRows).toHaveBeenCalledWith("hash-cached", undefined);
    expect(persistCsvRows).not.toHaveBeenCalled();
    expect(getCsvRows("hash-cached")?.rows).toHaveLength(2);
  });

  it("falls through to a full re-parse on cache hit when the on-disk row cache is missing", async () => {
    const events: Recorded = [];
    const store = makeStore(true);
    const { port, embed } = makeEmbeddings();
    const parsed = makeParseResult(2);
    const parse = vi.fn(() => parsed);
    const readFile = vi.fn(async () => "csv-text");
    const loadCsvRows = vi.fn<LoadCsvRowsFn>(async () => null);
    const persistCsvRows = vi.fn<PersistCsvRowsFn>(async () => {});

    await ingestCsv(
      "/tmp/cached-missing-rows.csv",
      "hash-fallthrough",
      (e) => events.push(e),
      {
        embeddings: port,
        store: store.store,
        readFile,
        statFile: async () => ({ size: 7 }),
        parse,
        loadCsvRows,
        persistCsvRows,
      },
    );

    expect(events.map((e) => e.kind)).toEqual([
      "file-start",
      "csv-progress",
      "file-done",
    ]);
    const done = events.at(-1) as Extract<IngestEvent, { kind: "file-done" }>;
    expect(done.cached).toBe(false);
    expect(done.chunks).toBe(2);
    expect(loadCsvRows).toHaveBeenCalledWith("hash-fallthrough", undefined);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(persistCsvRows).toHaveBeenCalledWith(
      "hash-fallthrough",
      parsed,
      undefined,
    );
    expect(getCsvRows("hash-fallthrough")?.rows).toHaveLength(2);
  });

  it("persists csv rows after a successful upsert on the happy path", async () => {
    const events: Recorded = [];
    const parsed = makeParseResult(2, { unmapped: ["EXTRA"] });
    const { deps, persistCsvRows } = makeDeps({
      readFile: async () => "csv-text",
      statFile: async () => ({ size: 5 }),
      parse: () => parsed,
      cacheBaseDir: "/tmp/cache-base-test",
    });

    await ingestCsv("/tmp/happy.csv", "hash-happy", (e) => events.push(e), deps);

    expect(persistCsvRows).toHaveBeenCalledTimes(1);
    expect(persistCsvRows).toHaveBeenCalledWith(
      "hash-happy",
      parsed,
      "/tmp/cache-base-test",
    );
    expect(events.map((e) => e.kind)).toEqual([
      "file-start",
      "csv-progress",
      "file-done",
    ]);
  });

  it("logs and continues to file-done when csv row persistence fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: Recorded = [];
    const parsed = makeParseResult(1);
    const { deps } = makeDeps({
      readFile: async () => "csv-text",
      statFile: async () => ({ size: 5 }),
      parse: () => parsed,
      persistCsvRows: async () => {
        throw new Error("disk full");
      },
    });

    await ingestCsv("/tmp/persist-fail.csv", "hash-pf", (e) => events.push(e), deps);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["file-start", "csv-progress", "file-done"]);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it("emits file-error with row context and does not upsert when parse produces no rows", async () => {
    const events: Recorded = [];
    const parsed: ParseResult = {
      rows: [],
      columnMap: emptyColumnMap(),
      unmapped: [],
      errors: [
        {
          kind: "parse",
          message: "Row 1: unparseable critical field(s) unitPrice",
          detail: { rowId: 1, missing: ["unitPrice"], raw: { ITEM_DESC: "X" } },
        },
      ],
    };
    const { deps, store, embed } = makeDeps({
      readFile: async () => "csv-text",
      statFile: async () => ({ size: 12 }),
      parse: () => parsed,
    });

    await ingestCsv("/tmp/bad.csv", "hash-bad", (e) => events.push(e), deps);

    expect(events.map((e) => e.kind)).toEqual(["file-start", "file-error"]);
    const errorEvent = events[1]!;
    expect(errorEvent).toMatchObject({
      kind: "file-error",
      file: "bad.csv",
      message: "Row 1: unparseable critical field(s) unitPrice",
    });
    expect((errorEvent as { detail?: unknown }).detail).toMatchObject({
      rowId: 1,
      missing: ["unitPrice"],
    });

    expect(embed).not.toHaveBeenCalled();
    expect(store.upserts).toHaveLength(0);
    expect(getCsvRows("hash-bad")).toBeUndefined();
  });

  it("includes unmapped headers in the file-done payload", async () => {
    const events: Recorded = [];
    const { deps } = makeDeps({
      readFile: async () => "csv-text",
      statFile: async () => ({ size: 5 }),
      parse: () => makeParseResult(1, { unmapped: ["FOO", "BAR"] }),
    });

    await ingestCsv("/tmp/u.csv", "hash-u", (e) => events.push(e), deps);

    const done = events.find((e) => e.kind === "file-done");
    expect(done).toBeDefined();
    expect((done as Extract<IngestEvent, { kind: "file-done" }>).unmapped).toEqual([
      "FOO",
      "BAR",
    ]);
  });

  it("emits file-error and bails out when read fails", async () => {
    const events: Recorded = [];
    const { deps, store, embed } = makeDeps({
      readFile: async () => {
        throw new Error("EACCES");
      },
      statFile: async () => ({ size: 1 }),
      parse: () => makeParseResult(1),
    });

    await ingestCsv("/tmp/missing.csv", "hash-missing", (e) => events.push(e), deps);

    expect(events.map((e) => e.kind)).toEqual(["file-start", "file-error"]);
    expect(events[1]).toMatchObject({
      kind: "file-error",
      file: "missing.csv",
      message: expect.stringContaining("EACCES"),
    });
    expect(embed).not.toHaveBeenCalled();
    expect(store.upserts).toHaveLength(0);
  });

  it("emits file-error when embeddings throw", async () => {
    const events: Recorded = [];
    const parsed = makeParseResult(2);
    const store = makeStore();
    const embed = vi.fn(async () => {
      throw new Error("rate-limited");
    });

    await ingestCsv(
      "/tmp/e.csv",
      "hash-e",
      (e) => events.push(e),
      {
        embeddings: { embedTexts: embed },
        store: store.store,
        readFile: async () => "csv-text",
        statFile: async () => ({ size: 1 }),
        parse: () => parsed,
      },
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("file-error");
    expect(kinds).not.toContain("file-done");
    expect(store.upserts).toHaveLength(0);
    // Cache holds the parsed rows even when embedding fails — they remain queryable.
    expect(getCsvRows("hash-e")?.rows).toHaveLength(2);
  });

  it("emits file-error when stat fails before file-start", async () => {
    const events: Recorded = [];
    const store = makeStore();
    const { port, embed } = makeEmbeddings();
    await ingestCsv(
      "/tmp/nope.csv",
      "hash-nope",
      (e) => events.push(e),
      {
        embeddings: port,
        store: store.store,
        readFile: async () => "",
        statFile: async () => {
          throw new Error("ENOENT");
        },
        parse: () => makeParseResult(0),
      },
    );

    expect(events.map((e) => e.kind)).toEqual(["file-error"]);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("rehydrateCsvRowsFromDisk", () => {
  it("returns true and populates the in-memory cache when on-disk rows exist", async () => {
    const parsed: ParseResult = {
      rows: [
        {
          rowId: 1,
          projectId: "P1",
          itemNo: "10100",
          itemDesc: "desc",
          unit: "LS",
          qty: 1,
          bidder: "ACME",
          unitPrice: 10,
          extAmt: 10,
          raw: {},
        },
      ],
      columnMap: emptyColumnMap(),
      unmapped: [],
      errors: [],
    };
    const loadCsvRows = vi.fn<LoadCsvRowsFn>(async () => parsed);

    const ok = await rehydrateCsvRowsFromDisk("hash-rh", { loadCsvRows });
    expect(ok).toBe(true);
    expect(getCsvRows("hash-rh")?.rows).toHaveLength(1);
  });

  it("returns false and does not populate the cache when the on-disk file is missing", async () => {
    const loadCsvRows = vi.fn<LoadCsvRowsFn>(async () => null);
    const ok = await rehydrateCsvRowsFromDisk("hash-missing", { loadCsvRows });
    expect(ok).toBe(false);
    expect(getCsvRows("hash-missing")).toBeUndefined();
  });

  it("returns false, logs a skip, and leaves the cache empty when the on-disk payload fails schema validation", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "ingest-csv-schema-"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fileHash = "hash-bad-schema";
      // Drop `unitPrice` — the field whose `undefined` value would break
      // `find_outliers` arithmetic if accepted blindly.
      const corrupt = {
        rows: [
          {
            rowId: 1,
            projectId: "P1",
            itemNo: "10100",
            itemDesc: "desc",
            unit: "LS",
            qty: 1,
            bidder: "ACME",
            extAmt: 10,
            raw: {},
          },
        ],
        columnMap: {
          projectId: "PROJ_ID",
          itemNo: "ITEM_NO",
          itemDesc: "ITEM_DESC",
          unit: "UNIT",
          qty: "QTY",
          unitPrice: "UNIT_PR",
          bidder: "BIDDER",
        },
        unmapped: [],
      };
      await writeJsonAtomic(csvRowsCachePath(fileHash, cacheDir), corrupt);

      const ok = await rehydrateCsvRowsFromDisk(fileHash, {
        cacheBaseDir: cacheDir,
      });

      expect(ok).toBe(false);
      expect(getCsvRows(fileHash)).toBeUndefined();
      const skipLogged = consoleSpy.mock.calls.some((args) => {
        const first = args[0];
        return (
          typeof first === "string" &&
          first.includes('"event":"skip"') &&
          first.includes('"reason":"schema-invalid"') &&
          first.includes('"scope":"ingest-csv"')
        );
      });
      expect(skipLogged).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("returns false, logs a skip, and leaves the cache empty when the on-disk payload is unparseable JSON", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "ingest-csv-badjson-"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fileHash = "hash-bad-json";
      const cachePath = csvRowsCachePath(fileHash, cacheDir);
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, "{ not valid json", { encoding: "utf8" });

      const ok = await rehydrateCsvRowsFromDisk(fileHash, {
        cacheBaseDir: cacheDir,
      });

      expect(ok).toBe(false);
      expect(getCsvRows(fileHash)).toBeUndefined();
      const skipLogged = consoleSpy.mock.calls.some((args) => {
        const first = args[0];
        return (
          typeof first === "string" &&
          first.includes('"event":"skip"') &&
          first.includes('"reason":"read-error"') &&
          first.includes('"scope":"ingest-csv"')
        );
      });
      expect(skipLogged).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("rehydrates from a well-formed on-disk payload written via the default persister", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "ingest-csv-good-"));
    try {
      const fileHash = "hash-good";
      const payload = {
        rows: [
          {
            rowId: 1,
            projectId: "P1",
            itemNo: "10100",
            itemDesc: "desc",
            unit: "LS",
            qty: 1,
            bidder: "ACME",
            unitPrice: 10,
            extAmt: 10,
            raw: {},
          },
        ],
        columnMap: {
          projectId: "PROJ_ID",
          itemNo: "ITEM_NO",
          itemDesc: "ITEM_DESC",
          unit: "UNIT",
          qty: "QTY",
          unitPrice: "UNIT_PR",
          bidder: "BIDDER",
        },
        unmapped: [],
      };
      await writeJsonAtomic(csvRowsCachePath(fileHash, cacheDir), payload);

      const ok = await rehydrateCsvRowsFromDisk(fileHash, {
        cacheBaseDir: cacheDir,
      });

      expect(ok).toBe(true);
      const cached = getCsvRows(fileHash);
      expect(cached?.rows).toHaveLength(1);
      expect(cached?.rows[0]?.unitPrice).toBe(10);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the in-memory cache already has the rows", async () => {
    const parsed: ParseResult = {
      rows: [
        {
          rowId: 1,
          projectId: "P1",
          itemNo: "10100",
          itemDesc: "x",
          unit: "LS",
          qty: 1,
          bidder: "ACME",
          unitPrice: 10,
          extAmt: 10,
          raw: {},
        },
      ],
      columnMap: emptyColumnMap(),
      unmapped: [],
      errors: [],
    };
    const loadCsvRows = vi.fn<LoadCsvRowsFn>(async () => parsed);
    await rehydrateCsvRowsFromDisk("hash-seed", { loadCsvRows });
    loadCsvRows.mockClear();

    const ok = await rehydrateCsvRowsFromDisk("hash-seed", { loadCsvRows });
    expect(ok).toBe(true);
    expect(loadCsvRows).not.toHaveBeenCalled();
  });
});
