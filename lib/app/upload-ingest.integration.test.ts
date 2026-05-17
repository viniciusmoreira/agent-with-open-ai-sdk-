import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Chunk, IngestEvent } from "@/lib/domain/types";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";

import {
  __resetEventBusForTests,
  emit,
  subscribe,
} from "./events";
import { ingestCsv } from "./ingest-csv";
import { clearCsvRowCache } from "./csv-row-cache";
import { handleIngestSse } from "./ingest-sse";
import { handleUpload, type UploadDeps } from "./upload";

const SAMPLE_CSV =
  "PROJECT_ID,ITEM_NO,ITEM_DESC,UNIT,QTY,UNIT_PR,BIDDER\n" +
  "A,001,Mobilization,LS,1,1000,ACME\n" +
  "A,001,Mobilization,LS,1,1100,BETA\n";

function makeStore(): VectorStorePort {
  const byHash = new Map<string, Chunk[]>();
  return {
    async hydrate() {},
    has(fileHash) {
      return byHash.has(fileHash);
    },
    async upsert(fileHash, chunks) {
      byHash.set(fileHash, chunks);
    },
    search() {
      return [];
    },
  };
}

function uploadRequest(blob: Blob, filename: string): Request {
  const form = new FormData();
  form.set("file", blob, filename);
  return new Request("http://localhost/api/upload", {
    method: "POST",
    body: form,
  });
}

async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs = 1000,
): Promise<IngestEvent[]> {
  const decoder = new TextDecoder();
  const events: IngestEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for SSE frames (got ${events.length}/${count})`,
      );
    }
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    for (const piece of chunk.split("\n\n")) {
      const line = piece.trim();
      if (!line.startsWith("data:")) continue;
      const json = line.slice("data:".length).trim();
      if (!json) continue;
      events.push(JSON.parse(json) as IngestEvent);
    }
  }
  return events;
}

beforeEach(() => {
  __resetEventBusForTests();
  clearCsvRowCache();
});

afterEach(() => {
  __resetEventBusForTests();
  vi.restoreAllMocks();
});

describe("upload → ingest → SSE end-to-end (CSV)", () => {
  it("publishes file-start, csv-progress, and file-done frames to a subscribed client", async () => {
    const store = makeStore();
    const embeddings = {
      embedTexts: vi.fn(async (texts: string[]) =>
        texts.map((_t, i) => [i + 1, 0]),
      ),
    };
    const writes: Array<{ filePath: string; bytes: Uint8Array }> = [];
    const fakeFs = new Map<string, Uint8Array>();
    const deps: UploadDeps = {
      store,
      maxBytes: 1024 * 1024,
      tmpDir: "/tmp/integration-uploads",
      mkdir: async () => {},
      writeFile: async (filePath, bytes) => {
        writes.push({ filePath, bytes });
        fakeFs.set(filePath, bytes);
      },
      dispatch: (run) => {
        void run();
      },
      ingestCsv: (filePath, fileHash) =>
        ingestCsv(filePath, fileHash, emit, {
          embeddings,
          store,
          readFile: async (p) => new TextDecoder().decode(fakeFs.get(p)!),
          statFile: async (p) => ({ size: fakeFs.get(p)!.byteLength }),
          persistCsvRows: async () => {},
          loadCsvRows: async () => null,
        }),
      ingestPdf: async () => {},
    };

    // Subscribe BEFORE triggering the upload (no replay).
    const abort = new AbortController();
    const sseReq = new Request("http://localhost/api/ingest", {
      method: "GET",
      signal: abort.signal,
    });
    const sseRes = handleIngestSse(sseReq, { subscribe });
    const reader = sseRes.body!.getReader();
    await reader.read();

    const blob = new Blob([SAMPLE_CSV], { type: "text/csv" });
    const uploadRes = await handleUpload(uploadRequest(blob, "bids.csv"), deps);
    expect(uploadRes.status).toBe(200);
    const body = (await uploadRes.json()) as {
      fileHash: string;
      cached: boolean;
    };
    expect(body.cached).toBe(false);

    const events = await readFrames(reader, 3);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("file-start");
    expect(kinds).toContain("csv-progress");
    expect(kinds).toContain("file-done");
    const fileDone = events.find((e) => e.kind === "file-done");
    expect(fileDone).toBeDefined();
    if (fileDone && fileDone.kind === "file-done") {
      expect(fileDone.cached).toBe(false);
      expect(fileDone.chunks).toBe(2);
    }

    abort.abort();
    await reader.cancel();
  });

  it("delivers the same stream to two concurrent SSE clients", async () => {
    const store = makeStore();
    const embeddings = {
      embedTexts: vi.fn(async (texts: string[]) =>
        texts.map((_t, i) => [i + 1, 0]),
      ),
    };
    const fakeFs = new Map<string, Uint8Array>();
    const deps: UploadDeps = {
      store,
      maxBytes: 1024 * 1024,
      tmpDir: "/tmp/integration-uploads",
      mkdir: async () => {},
      writeFile: async (filePath, bytes) => {
        fakeFs.set(filePath, bytes);
      },
      dispatch: (run) => {
        void run();
      },
      ingestCsv: (filePath, fileHash) =>
        ingestCsv(filePath, fileHash, emit, {
          embeddings,
          store,
          readFile: async (p) => new TextDecoder().decode(fakeFs.get(p)!),
          statFile: async (p) => ({ size: fakeFs.get(p)!.byteLength }),
          persistCsvRows: async () => {},
          loadCsvRows: async () => null,
        }),
      ingestPdf: async () => {},
    };

    const a = new AbortController();
    const b = new AbortController();
    const resA = handleIngestSse(
      new Request("http://localhost/api/ingest", { signal: a.signal }),
      { subscribe },
    );
    const resB = handleIngestSse(
      new Request("http://localhost/api/ingest", { signal: b.signal }),
      { subscribe },
    );
    const readerA = resA.body!.getReader();
    const readerB = resB.body!.getReader();
    await readerA.read();
    await readerB.read();

    const blob = new Blob([SAMPLE_CSV], { type: "text/csv" });
    await handleUpload(uploadRequest(blob, "bids.csv"), deps);

    const eventsA = await readFrames(readerA, 3);
    const eventsB = await readFrames(readerB, 3);
    expect(eventsA.map((e) => e.kind)).toEqual(eventsB.map((e) => e.kind));

    a.abort();
    b.abort();
    await readerA.cancel();
    await readerB.cancel();
  });
});
