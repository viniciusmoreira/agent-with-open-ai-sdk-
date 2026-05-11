import { z } from "zod";

import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";
import type {
  SourceFilter,
  VectorStorePort,
} from "@/lib/domain/ports/vector-store-port";
import type { SourceRef } from "@/lib/domain/types";

const DEFAULT_K = 5;
const MAX_K = 20;

export const searchDocumentsInputSchema = z
  .object({
    query: z.string().min(1).max(2000),
    k: z.number().int().positive().max(MAX_K).optional(),
    sourceType: z.enum(["csv-row", "pdf-page"]).optional(),
  })
  .strict();

export type SearchDocumentsInput = z.infer<typeof searchDocumentsInputSchema>;

export type SearchDocumentsResultChunk = {
  text: string;
  sourceRef: SourceRef;
  score: number;
};

export type SearchDocumentsResult = {
  chunks: SearchDocumentsResultChunk[];
};

const DESCRIPTION = [
  "Semantic search over ingested documents — both PDF page chunks (plan sets and spec volumes) and CSV item descriptions.",
  "Use for semantic or definitional questions: which items relate to a topic, what the specs say about a topic, finding similar descriptions.",
  "Returns text chunks with sourceRef (`csv-row` -> rowId citation; `pdf-page` -> page citation) and a similarity score.",
  "Optional: `k` (default 5; max 20), `sourceType` to filter to just CSV rows or PDF pages.",
  "Prefer query_bids for numeric / structural questions (rankings, totals, exact bidder/item filters).",
].join("\n");

export type SearchDocumentsDeps = {
  embeddings: EmbeddingsPort;
  store: VectorStorePort;
};

export type SearchDocumentsTool = {
  description: string;
  inputSchema: typeof searchDocumentsInputSchema;
  execute: (
    input: SearchDocumentsInput,
    options?: unknown,
  ) => Promise<SearchDocumentsResult>;
};

export function createSearchDocumentsTool(
  deps: SearchDocumentsDeps,
): SearchDocumentsTool {
  return {
    description: DESCRIPTION,
    inputSchema: searchDocumentsInputSchema,
    execute: async (input) => {
      const k = input.k ?? DEFAULT_K;
      const vectors = await deps.embeddings.embedTexts([input.query]);
      const queryVector = vectors[0];
      if (!queryVector || queryVector.length === 0) {
        return { chunks: [] };
      }
      const filter: SourceFilter | undefined = input.sourceType
        ? (ref) => ref.type === input.sourceType
        : undefined;
      const hits = deps.store.search(queryVector, k, filter);
      const chunks: SearchDocumentsResultChunk[] = hits.map((hit) => ({
        text: hit.chunk.text,
        sourceRef: hit.chunk.sourceRef,
        score: hit.score,
      }));
      return { chunks };
    },
  };
}

