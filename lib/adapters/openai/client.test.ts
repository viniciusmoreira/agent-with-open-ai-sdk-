import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetOpenAIClientForTests, getOpenAIClient } from "./client";

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  __resetOpenAIClientForTests();
  process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  __resetOpenAIClientForTests();
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
});

describe("getOpenAIClient", () => {
  it("returns a singleton instance", () => {
    const a = getOpenAIClient();
    const b = getOpenAIClient();
    expect(a).toBe(b);
  });

  it("exposes the embeddings endpoint on the underlying SDK", () => {
    const client = getOpenAIClient();
    const endpoint = client["embeddings"];
    expect(endpoint).toBeDefined();
    expect(typeof endpoint["create"]).toBe("function");
  });

  it("applies a request timeout so hung connections are bounded", () => {
    const client = getOpenAIClient();
    expect(client["timeout"]).toBeGreaterThan(0);
  });

  it("disables SDK-internal retries (retry is owned by withRetry)", () => {
    const client = getOpenAIClient();
    expect(client["maxRetries"]).toBe(0);
  });
});
