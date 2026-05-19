import { describe, expect, it, vi } from "vitest";

import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import { listDocuments } from "./list-documents";

function makeStore(
  overrides: Partial<VectorStorePort> = {},
): VectorStorePort & { hydrate: ReturnType<typeof vi.fn> } {
  return {
    hydrate: vi.fn(async () => {}),
    has: () => false,
    upsert: async () => {},
    search: () => [],
    list: () => [],
    ...overrides,
  } as VectorStorePort & { hydrate: ReturnType<typeof vi.fn> };
}

describe("listDocuments", () => {
  it("hydrates before reading the store", async () => {
    const order: string[] = [];
    const store = makeStore({
      hydrate: vi.fn(async () => {
        order.push("hydrate");
      }),
      list: () => {
        order.push("list");
        return [];
      },
    });
    await listDocuments({ store });
    expect(order).toEqual(["hydrate", "list"]);
  });

  it("returns the document summaries the store reports", async () => {
    const docs = [
      {
        fileHash: "h1",
        kind: "csv" as const,
        displayName: "bids.csv",
        chunks: 12,
      },
      {
        fileHash: "h2",
        kind: "pdf" as const,
        displayName: "plans.pdf",
        chunks: 4,
      },
    ];
    const store = makeStore({ list: () => docs });
    await expect(listDocuments({ store })).resolves.toEqual(docs);
  });

  it("propagates hydrate errors", async () => {
    const store = makeStore({
      hydrate: vi.fn(async () => {
        throw new Error("disk on fire");
      }),
    });
    await expect(listDocuments({ store })).rejects.toThrow("disk on fire");
  });
});
