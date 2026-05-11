import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IngestEvent } from "@/lib/domain/types";

import {
  __resetEventBusForTests,
  emit,
  subscribe,
} from "./events";
import { handleIngestSse } from "./ingest-sse";

beforeEach(() => {
  __resetEventBusForTests();
});

afterEach(() => {
  __resetEventBusForTests();
});

function makeRequest(controller: AbortController): Request {
  return new Request("http://localhost/api/ingest", {
    method: "GET",
    signal: controller.signal,
  });
}

async function readNextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  filter?: (chunk: string) => boolean,
): Promise<string> {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed before frame");
    const decoded = decoder.decode(value);
    if (filter && !filter(decoded)) continue;
    return decoded;
  }
}

describe("handleIngestSse", () => {
  it("returns text/event-stream with no-cache and no caching headers", () => {
    const abort = new AbortController();
    const res = handleIngestSse(makeRequest(abort), { subscribe });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("Cache-Control")).toMatch(/no-cache/);
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    abort.abort();
  });

  it("streams each emitted IngestEvent as one data: frame", async () => {
    const abort = new AbortController();
    const res = handleIngestSse(makeRequest(abort), { subscribe });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First frame is the initial comment frame; drain it.
    await readNextFrame(reader, decoder);

    const event: IngestEvent = {
      kind: "file-start",
      file: "sample.csv",
      sizeBytes: 42,
    };
    emit(event);
    const frame = await readNextFrame(reader, decoder, (c) =>
      c.startsWith("data:"),
    );
    expect(frame).toBe(`data: ${JSON.stringify(event)}\n\n`);

    abort.abort();
    await reader.cancel();
  });

  it("fans out to two concurrent SSE clients", async () => {
    const a = new AbortController();
    const b = new AbortController();
    const resA = handleIngestSse(makeRequest(a), { subscribe });
    const resB = handleIngestSse(makeRequest(b), { subscribe });
    const readerA = resA.body!.getReader();
    const readerB = resB.body!.getReader();
    const decoder = new TextDecoder();

    // Drain initial comment frames.
    await readNextFrame(readerA, decoder);
    await readNextFrame(readerB, decoder);

    const event: IngestEvent = {
      kind: "csv-progress",
      file: "sample.csv",
      rows: 7,
    };
    emit(event);
    const frameA = await readNextFrame(readerA, decoder, (c) =>
      c.startsWith("data:"),
    );
    const frameB = await readNextFrame(readerB, decoder, (c) =>
      c.startsWith("data:"),
    );
    expect(frameA).toBe(`data: ${JSON.stringify(event)}\n\n`);
    expect(frameB).toBe(`data: ${JSON.stringify(event)}\n\n`);

    a.abort();
    b.abort();
    await readerA.cancel();
    await readerB.cancel();
  });

  it("unsubscribes when the client aborts the request", async () => {
    const subs: Array<(e: IngestEvent) => void> = [];
    const fakeSubscribe = (handler: (e: IngestEvent) => void): (() => void) => {
      subs.push(handler);
      return () => {
        const idx = subs.indexOf(handler);
        if (idx >= 0) subs.splice(idx, 1);
      };
    };
    const abort = new AbortController();
    const res = handleIngestSse(makeRequest(abort), {
      subscribe: fakeSubscribe,
    });
    const reader = res.body!.getReader();
    // Drain initial comment frame.
    await readNextFrame(reader, new TextDecoder());
    expect(subs).toHaveLength(1);

    abort.abort();
    // Give the abort listener a tick to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(subs).toHaveLength(0);
    await reader.cancel();
  });

  it("unsubscribes when the consumer cancels the stream", async () => {
    const subs: Array<(e: IngestEvent) => void> = [];
    const fakeSubscribe = (handler: (e: IngestEvent) => void): (() => void) => {
      subs.push(handler);
      return () => {
        const idx = subs.indexOf(handler);
        if (idx >= 0) subs.splice(idx, 1);
      };
    };
    const abort = new AbortController();
    const res = handleIngestSse(makeRequest(abort), {
      subscribe: fakeSubscribe,
    });
    const reader = res.body!.getReader();
    await readNextFrame(reader, new TextDecoder());
    expect(subs).toHaveLength(1);
    await reader.cancel();
    expect(subs).toHaveLength(0);
  });
});
