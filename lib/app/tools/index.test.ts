import { describe, expect, it } from "vitest";

import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";

import { createTools } from "./index";

const embeddings: EmbeddingsPort = { embedTexts: async () => [[0]] };
const store: VectorStorePort = {
  async hydrate() {},
  has() {
    return false;
  },
  async upsert() {},
  search() {
    return [];
  },
};

describe("tools registry", () => {
  it("exposes exactly query_bids, find_outliers, search_documents", () => {
    const tools = createTools({ embeddings, store });
    expect(Object.keys(tools).sort()).toEqual([
      "find_outliers",
      "query_bids",
      "search_documents",
    ]);
  });

  it("each tool has a non-empty description and an inputSchema", () => {
    const tools = createTools({ embeddings, store });
    for (const name of ["query_bids", "find_outliers", "search_documents"] as const) {
      const tool = tools[name];
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });
});
