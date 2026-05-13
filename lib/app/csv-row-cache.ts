import type { BidRow, ParseResult } from "@/lib/domain/types";

const cache = new Map<string, ParseResult>();

// Keyed hydration state lives here so clearCsvRowCache can reset it atomically.
// Keys are cacheBaseDir values (empty string = default process.cwd() path).
export const csvHydrateState = {
  done: new Set<string>(),
  inflight: new Map<string, Promise<void>>(),
};

export function getCsvRows(fileHash: string): ParseResult | undefined {
  return cache.get(fileHash);
}

export function setCsvRows(fileHash: string, result: ParseResult): void {
  cache.set(fileHash, result);
}

export function getAllCsvRows(): BidRow[] {
  const all: BidRow[] = [];
  for (const result of cache.values()) {
    for (const row of result.rows) all.push(row);
  }
  return all;
}

export function clearCsvRowCache(): void {
  cache.clear();
  csvHydrateState.done.clear();
  csvHydrateState.inflight.clear();
}
