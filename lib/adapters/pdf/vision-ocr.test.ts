import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ocrCachePath } from "@/lib/adapters/cache/paths";
import { writeJsonAtomic } from "@/lib/adapters/cache/atomic-json";

import {
  createVisionOcr,
  OcrAdapterError,
  rasterizePdfPage,
  VISION_PROMPT,
  type CachedOcrPayload,
  type PdfToPngFn,
} from "./vision-ocr";

const createSpy = vi.fn();

vi.mock("@/lib/adapters/openai/client", () => ({
  getOpenAIClient: () => ({
    chat: { completions: { create: createSpy } },
  }),
  __resetOpenAIClientForTests: () => {},
}));

function fakeImage(seed: string): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
  }
  return bytes;
}

function visionResponse(text: string) {
  return { choices: [{ message: { content: text } }] };
}

function apiError(status: number): APIError {
  return new APIError(status, { error: { message: `boom-${status}` } }, undefined, undefined);
}

let tmp: string;

beforeEach(async () => {
  createSpy.mockReset();
  tmp = await mkdtemp(path.join(tmpdir(), "vision-ocr-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("createVisionOcr.extractPageText", () => {
  it("calls Vision on cache miss and writes the result to .cache/ocr/<hash>.json", async () => {
    createSpy.mockResolvedValue(visionResponse("page 1 text"));
    const image = fakeImage("miss");
    const adapter = createVisionOcr({ model: "gpt-4o-mini", cacheBase: tmp });

    const out = await adapter.extractPageText({ pageImage: image, page: 1 });

    expect(out).toEqual({ text: "page 1 text", cached: false });
    expect(createSpy).toHaveBeenCalledTimes(1);

    const hash = createHash("sha256").update(image).digest("hex");
    const cachePath = ocrCachePath(hash, tmp);
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as CachedOcrPayload;
    expect(cached).toEqual({
      pageImageHash: hash,
      model: "gpt-4o-mini",
      text: "page 1 text",
    });
  });

  it("returns the cached payload without calling Vision when the file is already on disk", async () => {
    const image = fakeImage("hit");
    const hash = createHash("sha256").update(image).digest("hex");
    await writeJsonAtomic<CachedOcrPayload>(ocrCachePath(hash, tmp), {
      pageImageHash: hash,
      model: "gpt-4o-mini",
      text: "from-cache",
    });
    const adapter = createVisionOcr({ model: "gpt-4o-mini", cacheBase: tmp });

    const out = await adapter.extractPageText({ pageImage: image, page: 3 });

    expect(out).toEqual({ text: "from-cache", cached: true });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("includes the documented prompt and an image_url content frame in the Vision request", async () => {
    createSpy.mockResolvedValue(visionResponse("ok"));
    const image = fakeImage("payload");
    const adapter = createVisionOcr({ model: "gpt-4o-mini", cacheBase: tmp });

    await adapter.extractPageText({ pageImage: image, page: 7 });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const args = createSpy.mock.calls[0]![0] as {
      model: string;
      messages: Array<{
        role: string;
        content: Array<
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string } }
        >;
      }>;
    };
    expect(args.model).toBe("gpt-4o-mini");
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0]!.role).toBe("user");
    const content = args.messages[0]!.content;
    const textFrame = content.find((c) => c.type === "text");
    const imageFrame = content.find((c) => c.type === "image_url");
    expect(textFrame).toBeDefined();
    expect(imageFrame).toBeDefined();
    expect((textFrame as { text: string }).text).toBe(VISION_PROMPT);
    const url = (imageFrame as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url.length).toBeGreaterThan("data:image/png;base64,".length);
  });

  it("retries on 5xx and surfaces a DomainError(kind: 'ocr') with the page when retries are exhausted", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    createSpy.mockRejectedValue(apiError(503));
    const adapter = createVisionOcr({
      model: "gpt-4o-mini",
      cacheBase: tmp,
      sleep,
    });

    await expect(
      adapter.extractPageText({ pageImage: fakeImage("err"), page: 5 }),
    ).rejects.toMatchObject({
      domainError: { kind: "ocr", page: 5 },
    });
    expect(createSpy).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000]);
  });

  it("does not write a cache file when the Vision call fails", async () => {
    createSpy.mockRejectedValue(apiError(400));
    const image = fakeImage("no-write");
    const adapter = createVisionOcr({ model: "gpt-4o-mini", cacheBase: tmp });

    await expect(
      adapter.extractPageText({ pageImage: image, page: 2 }),
    ).rejects.toBeInstanceOf(OcrAdapterError);

    const hash = createHash("sha256").update(image).digest("hex");
    await expect(readFile(ocrCachePath(hash, tmp), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("surfaces missing message content as a DomainError(kind: 'ocr')", async () => {
    createSpy.mockResolvedValue({ choices: [{ message: { content: null } }] });
    const adapter = createVisionOcr({ model: "gpt-4o-mini", cacheBase: tmp });
    await expect(
      adapter.extractPageText({ pageImage: fakeImage("null"), page: 9 }),
    ).rejects.toMatchObject({
      domainError: { kind: "ocr", page: 9 },
    });
  });
});

describe("rasterizePdfPage", () => {
  it("returns the PNG bytes for the requested page via the injected pdfToPng", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);
    const fakePdfToPng = vi.fn().mockResolvedValue([
      {
        pageNumber: 1,
        name: "page_1.png",
        content: Buffer.from(png),
        path: "",
        width: 100,
        height: 100,
      },
    ]);

    const out = await rasterizePdfPage(new Uint8Array([0, 0, 0]), 1, {
      // cast to satisfy the option's typing without hitting the real lib
      pdfToPng: fakePdfToPng as unknown as PdfToPngFn,
    });

    expect(Array.from(out)).toEqual(Array.from(png));
    expect(fakePdfToPng).toHaveBeenCalledTimes(1);
    const props = fakePdfToPng.mock.calls[0]![1];
    expect(props.pagesToProcess).toEqual([1]);
    expect(props.strictPagesToProcess).toBe(true);
  });

  it("wraps rasterizer failures into DomainError(kind: 'pdf') with file and page", async () => {
    const fakePdfToPng = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      rasterizePdfPage(new Uint8Array([0]), 4, {
        file: "plans.pdf",
        pdfToPng: fakePdfToPng as unknown as Parameters<
          typeof rasterizePdfPage
        >[2] extends { pdfToPng?: infer T }
          ? T
          : never,
      }),
    ).rejects.toMatchObject({
      domainError: {
        kind: "pdf",
        file: "plans.pdf",
        page: 4,
      },
    });
  });

  it("treats an empty rasterizer result as a DomainError(kind: 'pdf')", async () => {
    const fakePdfToPng = vi.fn().mockResolvedValue([]);
    await expect(
      rasterizePdfPage(new Uint8Array([0]), 2, {
        file: "plans.pdf",
        pdfToPng: fakePdfToPng as unknown as Parameters<
          typeof rasterizePdfPage
        >[2] extends { pdfToPng?: infer T }
          ? T
          : never,
      }),
    ).rejects.toMatchObject({
      domainError: { kind: "pdf", file: "plans.pdf", page: 2 },
    });
  });
});

describe("integration: rasterize → OCR → cache round-trip", () => {
  it("rasterizes through the injected rasterizer, persists the cache, and a second call is a cache hit", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42, 7, 1]);
    const fakePdfToPng = vi.fn().mockResolvedValue([
      {
        pageNumber: 1,
        name: "page_1.png",
        content: Buffer.from(png),
        path: "",
        width: 50,
        height: 50,
      },
    ]);
    createSpy.mockResolvedValueOnce(visionResponse("extracted text from page"));

    const pageImage = await rasterizePdfPage(new Uint8Array([1, 2, 3, 4]), 1, {
      pdfToPng: fakePdfToPng as unknown as PdfToPngFn,
    });

    const adapter = createVisionOcr({ model: "gpt-4o-mini", cacheBase: tmp });
    const first = await adapter.extractPageText({ pageImage, page: 1 });
    expect(first).toEqual({ text: "extracted text from page", cached: false });

    const hash = createHash("sha256").update(pageImage).digest("hex");
    const cachePath = ocrCachePath(hash, tmp);
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as CachedOcrPayload;
    expect(cached.text).toBe("extracted text from page");
    expect(cached.model).toBe("gpt-4o-mini");
    expect(cached.pageImageHash).toBe(hash);

    const second = await adapter.extractPageText({ pageImage, page: 1 });
    expect(second).toEqual({ text: "extracted text from page", cached: true });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
