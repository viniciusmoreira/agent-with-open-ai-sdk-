import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IngestEvent } from "@/lib/domain/types";

import {
  __resetEventBusForTests,
  emit,
  subscribe,
  type IngestEventHandler,
} from "./events";

const sampleEvent: IngestEvent = {
  kind: "file-start",
  file: "sample.csv",
  sizeBytes: 1024,
};

const otherEvent: IngestEvent = {
  kind: "csv-progress",
  file: "sample.csv",
  rows: 42,
};

beforeEach(() => {
  __resetEventBusForTests();
});

afterEach(() => {
  __resetEventBusForTests();
  vi.restoreAllMocks();
});

describe("event bus", () => {
  it("delivers an emitted event synchronously to a single subscriber", () => {
    const received: IngestEvent[] = [];
    const handler: IngestEventHandler = (event) => {
      received.push(event);
    };
    subscribe(handler);
    emit(sampleEvent);
    expect(received).toEqual([sampleEvent]);
  });

  it("removes the handler after the returned unsubscribe is called", () => {
    const received: IngestEvent[] = [];
    const unsubscribe = subscribe((event) => {
      received.push(event);
    });
    emit(sampleEvent);
    unsubscribe();
    emit(otherEvent);
    expect(received).toEqual([sampleEvent]);
  });

  it("treats double unsubscribe as a no-op", () => {
    const received: IngestEvent[] = [];
    const unsubscribe = subscribe((event) => {
      received.push(event);
    });
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    emit(sampleEvent);
    expect(received).toEqual([]);
  });

  it("isolates handler exceptions from other subscribers", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: IngestEvent[] = [];
    subscribe(() => {
      throw new Error("boom");
    });
    subscribe((event) => {
      received.push(event);
    });
    emit(sampleEvent);
    expect(received).toEqual([sampleEvent]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("does not deliver prior events to late subscribers", () => {
    emit(sampleEvent);
    const received: IngestEvent[] = [];
    subscribe((event) => {
      received.push(event);
    });
    expect(received).toEqual([]);
    emit(otherEvent);
    expect(received).toEqual([otherEvent]);
  });

  it("delivers to subscribers in registration order", () => {
    const order: string[] = [];
    subscribe(() => {
      order.push("first");
    });
    subscribe(() => {
      order.push("second");
    });
    subscribe(() => {
      order.push("third");
    });
    emit(sampleEvent);
    expect(order).toEqual(["first", "second", "third"]);
  });
});

describe("event bus integration", () => {
  it("fans out every event to two concurrent subscribers in the same order", () => {
    const a: IngestEvent[] = [];
    const b: IngestEvent[] = [];
    subscribe((event) => {
      a.push(event);
    });
    subscribe((event) => {
      b.push(event);
    });
    const events: IngestEvent[] = [
      sampleEvent,
      otherEvent,
      { kind: "file-done", file: "sample.csv", chunks: 12, cached: false },
      { kind: "file-error", file: "sample.csv", message: "stopped" },
    ];
    for (const event of events) {
      emit(event);
    }
    expect(a).toEqual(events);
    expect(b).toEqual(events);
  });

  it("emit + subscribe complete in under 1ms for 100 subscribers", () => {
    for (let i = 0; i < 100; i++) {
      subscribe(() => {});
    }
    const start = performance.now();
    emit(sampleEvent);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1);
  });
});
