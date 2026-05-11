import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  cacheRoot,
  embeddingsCacheDir,
  embeddingsCachePath,
  ocrCacheDir,
  ocrCachePath,
} from "./paths";

describe("cache paths", () => {
  const base = "/tmp/agent-test-root";

  it("places the cache root under the base directory", () => {
    expect(cacheRoot(base)).toBe(path.join(base, ".cache"));
  });

  it("resolves embeddings directory under .cache/embeddings", () => {
    expect(embeddingsCacheDir(base)).toBe(path.join(base, ".cache", "embeddings"));
  });

  it("resolves ocr directory under .cache/ocr", () => {
    expect(ocrCacheDir(base)).toBe(path.join(base, ".cache", "ocr"));
  });

  it("composes embeddings cache path as <hash>-<model>.json", () => {
    const filePath = embeddingsCachePath("abc123", "text-embedding-3-small", base);
    expect(filePath).toBe(
      path.join(base, ".cache", "embeddings", "abc123-text-embedding-3-small.json"),
    );
  });

  it("composes ocr cache path as <pageHash>.json", () => {
    const filePath = ocrCachePath("deadbeef", base);
    expect(filePath).toBe(path.join(base, ".cache", "ocr", "deadbeef.json"));
  });

  it("defaults the base directory to process.cwd()", () => {
    expect(cacheRoot()).toBe(path.join(process.cwd(), ".cache"));
    expect(embeddingsCachePath("h", "m")).toBe(
      path.join(process.cwd(), ".cache", "embeddings", "h-m.json"),
    );
    expect(ocrCachePath("h")).toBe(path.join(process.cwd(), ".cache", "ocr", "h.json"));
  });
});
