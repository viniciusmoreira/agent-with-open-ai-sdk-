// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

import type { IngestEvent } from "@/lib/domain/types";
import { useIngestStream } from "@/components/upload-panel/use-ingest-stream";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<
    string,
    Set<(e: MessageEvent<string>) => void>
  >();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.closed = true;
  }
  emit(payload: unknown) {
    const data =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    const event = new MessageEvent<string>("message", { data });
    for (const fn of this.listeners.get("message") ?? []) fn(event);
  }
}

const originalEventSource = (globalThis as { EventSource?: unknown })
  .EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

function Harness({ onEvent }: { onEvent: (e: IngestEvent) => void }) {
  useIngestStream(onEvent);
  return null;
}

describe("useIngestStream", () => {
  it("opens an EventSource on mount and forwards parsed events to the handler", () => {
    const onEvent = vi.fn();
    render(<Harness onEvent={onEvent} />);
    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe("/api/ingest");
    act(() => {
      source.emit({ kind: "file-start", file: "x.csv", sizeBytes: 100 });
    });
    expect(onEvent).toHaveBeenCalledWith({
      kind: "file-start",
      file: "x.csv",
      sizeBytes: 100,
    });
  });

  it("ignores malformed payloads without crashing", () => {
    const onEvent = vi.fn();
    render(<Harness onEvent={onEvent} />);
    const source = MockEventSource.instances[0]!;
    act(() => {
      source.emit("not-json");
      source.emit({ noKind: true });
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("closes the EventSource on unmount", () => {
    const onEvent = vi.fn();
    const { unmount } = render(<Harness onEvent={onEvent} />);
    const source = MockEventSource.instances[0]!;
    unmount();
    expect(source.closed).toBe(true);
  });
});
