import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEnv, loadEnv } from "./env";

describe("loadEnv", () => {
  it("returns a typed env when all required keys are present", () => {
    const result = loadEnv({
      OPENAI_API_KEY: "sk-test-key",
      EMBEDDING_MODEL: "text-embedding-3-large",
      REASONING_MODEL: "gpt-4.1",
      VISION_OCR_MODEL: "gpt-4o",
      MAX_UPLOAD_BYTES: "1048576",
    });
    expect(result).toEqual({
      OPENAI_API_KEY: "sk-test-key",
      EMBEDDING_MODEL: "text-embedding-3-large",
      REASONING_MODEL: "gpt-4.1",
      VISION_OCR_MODEL: "gpt-4o",
      MAX_UPLOAD_BYTES: 1048576,
      UPLOAD_INGEST_CONCURRENCY: 2,
    });
  });

  it("applies documented defaults when optional keys are absent", () => {
    const result = loadEnv({ OPENAI_API_KEY: "sk-test-key" });
    expect(result.EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(result.REASONING_MODEL).toBe("gpt-4o");
    expect(result.VISION_OCR_MODEL).toBe("gpt-4o-mini");
    expect(result.MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(result.UPLOAD_INGEST_CONCURRENCY).toBe(2);
  });

  it("throws a descriptive error when OPENAI_API_KEY is missing", () => {
    expect(() => loadEnv({})).toThrow(/OPENAI_API_KEY/);
  });

  it("throws when OPENAI_API_KEY is an empty string", () => {
    expect(() => loadEnv({ OPENAI_API_KEY: "" })).toThrow(/OPENAI_API_KEY/);
  });
});

describe("getEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test-getenv";
    delete process.env.EMBEDDING_MODEL;
    delete process.env.REASONING_MODEL;
    delete process.env.VISION_OCR_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reads from process.env on first call and caches the result", async () => {
    vi.resetModules();
    const mod = await import("./env");
    const first = mod.getEnv();
    expect(first.OPENAI_API_KEY).toBe("sk-test-getenv");
    expect(first.EMBEDDING_MODEL).toBe("text-embedding-3-small");

    process.env.OPENAI_API_KEY = "sk-different";
    const second = mod.getEnv();
    expect(second).toBe(first);
    expect(second.OPENAI_API_KEY).toBe("sk-test-getenv");
  });

  it("exposes the same module-level cache to repeat callers", () => {
    process.env.OPENAI_API_KEY = "sk-cached";
    const first = getEnv();
    const second = getEnv();
    expect(second).toBe(first);
  });
});
