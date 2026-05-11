import type { ParseResult } from "@/lib/domain/types";

const cache = new Map<string, ParseResult>();

export function getCsvRows(fileHash: string): ParseResult | undefined {
  return cache.get(fileHash);
}

export function setCsvRows(fileHash: string, result: ParseResult): void {
  cache.set(fileHash, result);
}

export function clearCsvRowCache(): void {
  cache.clear();
}
