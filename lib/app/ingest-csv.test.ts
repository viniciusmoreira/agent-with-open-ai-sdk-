import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import type { Chunk, IngestEvent, ParseResult } from "@/lib/domain/types";

import { clearCsvRowCache, getCsvRows } from "./csv-row-cache";
import { ingestCsv, type IngestCsvDeps } from "./ingest-csv";

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
} {
  const store = makeStore();
  const { port, embed } = makeEmbeddings();
  const deps: IngestCsvDeps = {
    embeddings: port,
    store: store.store,
    readFile: async () => "",
    statFile: async () => ({ size: 0 }),
    parse: () => ({ rows: [], columnMap: emptyColumnMap(), unmapped: [], errors: [] }),
    ...overrides,
  };
  return { deps, store, embed };
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

  it("short-circuits with cached:true and skips embedding when store.has(fileHash)", async () => {
    const events: Recorded = [];
    const store = makeStore(true);
    const { port, embed } = makeEmbeddings();
    const parse = vi.fn(() => makeParseResult(2));
    const readFile = vi.fn(async () => "csv-text");

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
