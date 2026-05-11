import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryVectorStore } from "@/lib/adapters/vector-store/in-memory";
import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { IngestEvent } from "@/lib/domain/types";

import { clearCsvRowCache, getCsvRows } from "./csv-row-cache";
import { ingestCsv } from "./ingest-csv";

const SAMPLE_CSV = path.resolve(
  __dirname,
  "../../docs/sample_bid_tabulation.csv",
);
const TEST_MODEL = "test-model";

function deterministicEmbed(text: string): number[] {
  let h1 = 2166136261;
  let h2 = 1779033703;
  for (let i = 0; i < text.length; i++) {
    h1 ^= text.charCodeAt(i);
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + text.charCodeAt(i) * 31) >>> 0;
  }
  return [h1 / 0xffffffff, h2 / 0xffffffff];
}

const embeddings: EmbeddingsPort = {
  embedTexts: vi.fn(async (texts: string[]) => texts.map(deterministicEmbed)),
};

afterEach(() => {
  clearCsvRowCache();
  vi.clearAllMocks();
});

describe("ingestCsv integration (sample_bid_tabulation.csv)", () => {
  it("ingests end-to-end and produces a non-empty store; second run is a cache hit", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "ingest-csv-int-"));
    try {
      const store = new InMemoryVectorStore({
        embeddingModel: TEST_MODEL,
        cacheBaseDir: cacheDir,
      });

      const events: IngestEvent[] = [];
      const fileHash = "sample-bid-hash";

      await ingestCsv(
        SAMPLE_CSV,
        fileHash,
        (e) => events.push(e),
        { embeddings, store, cacheBaseDir: cacheDir },
      );

      const kinds = events.map((e) => e.kind);
      expect(kinds[0]).toBe("file-start");
      expect(kinds).toContain("csv-progress");
      expect(kinds[kinds.length - 1]).toBe("file-done");

      const done = events.at(-1) as Extract<IngestEvent, { kind: "file-done" }>;
      expect(done.cached).toBe(false);
      expect(done.chunks).toBeGreaterThan(0);

      expect(store.has(fileHash)).toBe(true);

      const parsed = getCsvRows(fileHash);
      expect(parsed).toBeDefined();
      expect(parsed!.rows.length).toBeGreaterThan(0);

      const queryVec = deterministicEmbed(parsed!.rows[0]!.itemDesc);
      const results = store.search(queryVec, 1);
      expect(results).toHaveLength(1);
      expect(results[0]!.sourceRef.type).toBe("csv-row");

      const initialCalls = (embeddings.embedTexts as ReturnType<typeof vi.fn>).mock
        .calls.length;
      const cachedEvents: IngestEvent[] = [];

      await ingestCsv(
        SAMPLE_CSV,
        fileHash,
        (e) => cachedEvents.push(e),
        { embeddings, store, cacheBaseDir: cacheDir },
      );

      const cachedKinds = cachedEvents.map((e) => e.kind);
      expect(cachedKinds).toEqual(["file-start", "file-done"]);
      const cachedDone = cachedEvents[1] as Extract<
        IngestEvent,
        { kind: "file-done" }
      >;
      expect(cachedDone.cached).toBe(true);
      expect(cachedDone.chunks).toBe(0);

      const finalCalls = (embeddings.embedTexts as ReturnType<typeof vi.fn>).mock
        .calls.length;
      expect(finalCalls).toBe(initialCalls);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
