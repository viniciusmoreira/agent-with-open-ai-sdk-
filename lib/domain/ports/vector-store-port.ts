import type { Chunk, SourceRef } from "../types";

export type SourceFilter = (ref: SourceRef) => boolean;

export interface VectorStorePort {
  hydrate(): Promise<void>;
  has(fileHash: string): boolean;
  upsert(fileHash: string, chunks: Chunk[]): Promise<void>;
  search(queryVector: number[], k: number, filter?: SourceFilter): Chunk[];
}
