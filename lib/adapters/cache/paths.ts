import path from "node:path";

export const CACHE_DIR_NAME = ".cache";
export const EMBEDDINGS_NAMESPACE = "embeddings";
export const OCR_NAMESPACE = "ocr";

export function cacheRoot(base: string = process.cwd()): string {
  return path.join(base, CACHE_DIR_NAME);
}

export function embeddingsCacheDir(base?: string): string {
  return path.join(cacheRoot(base), EMBEDDINGS_NAMESPACE);
}

export function ocrCacheDir(base?: string): string {
  return path.join(cacheRoot(base), OCR_NAMESPACE);
}

export function embeddingsCachePath(
  fileHash: string,
  embeddingModel: string,
  base?: string,
): string {
  return path.join(embeddingsCacheDir(base), `${fileHash}-${embeddingModel}.json`);
}

export function ocrCachePath(pageImageHash: string, base?: string): string {
  return path.join(ocrCacheDir(base), `${pageImageHash}.json`);
}
