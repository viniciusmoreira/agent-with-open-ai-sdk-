import { tool } from "ai";
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

export function createSearchDocumentsTool(deps: SearchDocumentsDeps) {
  return tool({
    description: DESCRIPTION,
    inputSchema: searchDocumentsInputSchema,
    execute: async (input): Promise<SearchDocumentsResult> => {
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
      const queryNorm = vectorNorm(queryVector);
      const chunks: SearchDocumentsResultChunk[] = hits.map((chunk) => ({
        text: chunk.text,
        sourceRef: chunk.sourceRef,
        score: cosineScore(chunk.vector, queryVector, queryNorm),
      }));
      return { chunks };
    },
  });
}

function cosineScore(
  a: Float32Array,
  b: number[],
  bNorm: number,
): number {
  if (bNorm === 0) return 0;
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let aSq = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aSq += av * av;
  }
  const aNorm = Math.sqrt(aSq);
  if (aNorm === 0) return 0;
  return dot / (aNorm * bNorm);
}

function vectorNorm(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
}
