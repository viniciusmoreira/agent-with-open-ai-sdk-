import { getAllCsvRows } from "@/lib/app/csv-row-cache";
import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";
import type { BidRow } from "@/lib/domain/types";

import { createFindOutliersTool } from "./find-outliers";
import { createQueryBidsTool } from "./query-bids";
import { createSearchDocumentsTool } from "./search-documents";

export type ToolsDeps = {
  embeddings: EmbeddingsPort;
  store: VectorStorePort;
  listRows?: () => readonly BidRow[];
};

export function createTools(deps: ToolsDeps) {
  const listRows = deps.listRows ?? getAllCsvRows;
  return {
    query_bids: createQueryBidsTool({ listRows }),
    find_outliers: createFindOutliersTool({ listRows }),
    search_documents: createSearchDocumentsTool({
      embeddings: deps.embeddings,
      store: deps.store,
    }),
  };
}

export type ToolsRegistry = ReturnType<typeof createTools>;

export { createQueryBidsTool } from "./query-bids";
export { createFindOutliersTool } from "./find-outliers";
export { createSearchDocumentsTool } from "./search-documents";
