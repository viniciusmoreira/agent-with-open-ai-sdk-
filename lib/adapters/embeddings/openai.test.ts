import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/adapters/openai/client", () => {
  return {
    getOpenAIClient: () => ({
      embeddings: { create: createSpy },
    }),
    __resetOpenAIClientForTests: () => {},
  };
});

import { createOpenAIEmbeddings } from "./openai";

const createSpy = vi.fn();

type CreateArgs = { model: string; input: string[] };

function deterministicVector(text: string): number[] {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) & 0xffff;
  return [h / 0xffff, text.length, 0];
}

function happyResponse(
  args: CreateArgs,
): { data: { embedding: number[]; index: number }[] } {
  return { data: args.input.map((t, i) => ({ embedding: deterministicVector(t), index: i })) };
}

function apiError(status: number): APIError {
  return new APIError(status, { error: { message: `boom-${status}` } }, undefined, undefined);
}

beforeEach(() => {
  createSpy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createOpenAIEmbeddings.embedTexts", () => {
  it("returns [] without calling the SDK on empty input", async () => {
    const adapter = createOpenAIEmbeddings({ model: "text-embedding-3-small" });
    const out = await adapter.embedTexts([]);
    expect(out).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("issues one SDK call with the configured model and returns the embedding", async () => {
    createSpy.mockImplementation(async (args: CreateArgs) => happyResponse(args));
    const adapter = createOpenAIEmbeddings({ model: "text-embedding-3-small" });
    const out = await adapter.embedTexts(["hello"]);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["hello"],
    });
    expect(out).toEqual([deterministicVector("hello")]);
  });

  it("falls back to the env-configured model when not provided", async () => {
    createSpy.mockImplementation(async (args: CreateArgs) => happyResponse(args));
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const adapter = createOpenAIEmbeddings();
      await adapter.embedTexts(["x"]);
      const call = createSpy.mock.calls[0]![0] as CreateArgs;
      expect(call.model).toBe("text-embedding-3-small");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("retries after a 429 and succeeds on the second attempt", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    createSpy
      .mockRejectedValueOnce(apiError(429))
      .mockImplementationOnce(async (args: CreateArgs) => happyResponse(args));
    const adapter = createOpenAIEmbeddings({ model: "m", sleep });
    const out = await adapter.embedTexts(["a"]);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(out).toEqual([deterministicVector("a")]);
  });

  it("retries on 5xx then surfaces the final error when retries are exhausted", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    createSpy.mockRejectedValue(apiError(500));
    const adapter = createOpenAIEmbeddings({ model: "m", sleep });
    await expect(adapter.embedTexts(["a"])).rejects.toBeInstanceOf(APIError);
    expect(createSpy).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000]);
  });

  it("does not retry on non-retryable errors (e.g. 400)", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    createSpy.mockRejectedValue(apiError(400));
    const adapter = createOpenAIEmbeddings({ model: "m", sleep });
    await expect(adapter.embedTexts(["a"])).rejects.toBeInstanceOf(APIError);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("batches large inputs at 100 per request", async () => {
    createSpy.mockImplementation(async (args: CreateArgs) => happyResponse(args));
    const adapter = createOpenAIEmbeddings({ model: "m" });
    const inputs = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const out = await adapter.embedTexts(inputs);
    expect(createSpy).toHaveBeenCalledTimes(3);
    const sizes = createSpy.mock.calls.map((c) => (c[0] as CreateArgs).input.length);
    expect(sizes).toEqual([100, 100, 50]);
    expect(out).toHaveLength(250);
    expect(out[0]).toEqual(deterministicVector("t0"));
    expect(out[249]).toEqual(deterministicVector("t249"));
  });

  it("returns an array whose length matches the input length with deterministic vectors", async () => {
    createSpy.mockImplementation(async (args: CreateArgs) => happyResponse(args));
    const adapter = createOpenAIEmbeddings({ model: "m" });
    const out = await adapter.embedTexts(["alpha", "beta", "gamma"]);
    expect(out).toHaveLength(3);
    expect(out).toEqual([
      deterministicVector("alpha"),
      deterministicVector("beta"),
      deterministicVector("gamma"),
    ]);
  });

  it("places embeddings by item.index, not arrival order", async () => {
    createSpy.mockImplementationOnce(async (args: CreateArgs) => ({
      data: [
        { embedding: deterministicVector(args.input[2]!), index: 2 },
        { embedding: deterministicVector(args.input[0]!), index: 0 },
        { embedding: deterministicVector(args.input[1]!), index: 1 },
      ],
    }));
    const adapter = createOpenAIEmbeddings({ model: "m" });
    const out = await adapter.embedTexts(["alpha", "beta", "gamma"]);
    expect(out).toEqual([
      deterministicVector("alpha"),
      deterministicVector("beta"),
      deterministicVector("gamma"),
    ]);
  });

  it("throws when an item index is out of range", async () => {
    createSpy.mockImplementationOnce(async () => ({
      data: [{ embedding: [1, 2, 3], index: 5 }],
    }));
    const adapter = createOpenAIEmbeddings({ model: "m" });
    await expect(adapter.embedTexts(["only-one"])).rejects.toThrow(
      "embedding index out of range",
    );
  });

  it("throws when an embedding is missing from the response", async () => {
    createSpy.mockImplementationOnce(async () => ({
      data: [{ embedding: [1, 2, 3], index: 0 }],
    }));
    const adapter = createOpenAIEmbeddings({ model: "m" });
    await expect(adapter.embedTexts(["a", "b"])).rejects.toThrow(
      "missing embedding for batch index 1",
    );
  });
});
