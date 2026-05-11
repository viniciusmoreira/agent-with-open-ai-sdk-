import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("returns a typed env when all required keys are present", () => {
    const result = loadEnv({
      OPENAI_API_KEY: "sk-test-key",
      EMBEDDING_MODEL: "text-embedding-3-large",
      REASONING_MODEL: "gpt-4.1",
      VISION_OCR_MODEL: "gpt-4o",
    });
    expect(result).toEqual({
      OPENAI_API_KEY: "sk-test-key",
      EMBEDDING_MODEL: "text-embedding-3-large",
      REASONING_MODEL: "gpt-4.1",
      VISION_OCR_MODEL: "gpt-4o",
    });
  });

  it("applies documented defaults when optional keys are absent", () => {
    const result = loadEnv({ OPENAI_API_KEY: "sk-test-key" });
    expect(result.EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(result.REASONING_MODEL).toBe("gpt-4o");
    expect(result.VISION_OCR_MODEL).toBe("gpt-4o-mini");
  });

  it("throws a descriptive error when OPENAI_API_KEY is missing", () => {
    expect(() => loadEnv({})).toThrow(/OPENAI_API_KEY/);
  });

  it("throws when OPENAI_API_KEY is an empty string", () => {
    expect(() => loadEnv({ OPENAI_API_KEY: "" })).toThrow(/OPENAI_API_KEY/);
  });
});
