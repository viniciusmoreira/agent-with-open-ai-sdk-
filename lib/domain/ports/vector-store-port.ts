import type { Chunk, SourceRef } from "../types";

export type SourceFilter = (ref: SourceRef) => boolean;
export type SearchHit = { chunk: Chunk; score: number };

export type DocumentSummary = {
  fileHash: string;
  kind: "csv" | "pdf";
  displayName: string;
  chunks: number;
};

export interface VectorStorePort {
  hydrate(): Promise<void>;
  has(fileHash: string): boolean;
  upsert(fileHash: string, chunks: Chunk[]): Promise<void>;
  search(queryVector: number[], k: number, filter?: SourceFilter): SearchHit[];
  list(): DocumentSummary[];
}
