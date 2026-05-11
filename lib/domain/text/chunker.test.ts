import { describe, expect, it } from "vitest";

import { chunkText, type Tokenizer } from "./chunker";

function wordTokenizer(): Tokenizer {
  return {
    encode: (text: string) => Array.from(text).map((ch) => ch.charCodeAt(0)),
    decode: (ids: number[]) => String.fromCharCode(...ids),
  };
}

describe("chunkText", () => {
  it("returns an empty array for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  it("returns the trimmed text as a single chunk when length fits inside chunkSize", () => {
    const out = chunkText("hello world", { chunkSize: 100, overlap: 10 });
    expect(out).toEqual(["hello world"]);
  });

  it("splits long text into overlapping chunks of ~chunkSize tokens with ~overlap reuse", () => {
    const tokenizer = wordTokenizer();
    const text = "a".repeat(2500);
    const chunks = chunkText(text, {
      tokenizer,
      chunkSize: 1000,
      overlap: 150,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.length).toBe(1000);
    }
    const last = chunks[chunks.length - 1]!;
    expect(last.length).toBeLessThanOrEqual(1000);
    expect(last.length).toBeGreaterThan(0);

    expect(chunks[1]!.startsWith(chunks[0]!.slice(-150))).toBe(true);
  });

  it("produces a final chunk that may be shorter than chunkSize", () => {
    const tokenizer = wordTokenizer();
    const text = "x".repeat(2050);
    const chunks = chunkText(text, {
      tokenizer,
      chunkSize: 1000,
      overlap: 150,
    });
    const last = chunks[chunks.length - 1]!;
    expect(last.length).toBeLessThan(1000);
  });

  it("uses the gpt-tokenizer default when no tokenizer override is supplied", () => {
    const longish = "The quick brown fox jumps over the lazy dog. ".repeat(50);
    const chunks = chunkText(longish, { chunkSize: 20, overlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeGreaterThan(0);
  });

  it("rejects invalid chunkSize and overlap", () => {
    expect(() => chunkText("abc", { chunkSize: 0 })).toThrow();
    expect(() => chunkText("abc", { chunkSize: 10, overlap: -1 })).toThrow();
    expect(() => chunkText("abc", { chunkSize: 10, overlap: 10 })).toThrow();
    expect(() => chunkText("abc", { chunkSize: 10, overlap: 11 })).toThrow();
  });

  it("skips empty decoded slices instead of producing empty chunks", () => {
    const tokenizer: Tokenizer = {
      encode: () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      decode: () => "   ",
    };
    expect(
      chunkText("ignored", { tokenizer, chunkSize: 3, overlap: 1 }),
    ).toEqual([]);
  });
});
