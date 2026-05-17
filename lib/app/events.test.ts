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

describe("event bus topic filter", () => {
  const aHashEvent: IngestEvent = {
    kind: "file-start",
    file: "aaa111-report.csv",
    sizeBytes: 1024,
  };
  const bHashEvent: IngestEvent = {
    kind: "file-start",
    file: "bbb222-plans.pdf",
    sizeBytes: 2048,
  };

  it("delivers only events whose file starts with the requested fileHash", () => {
    const received: IngestEvent[] = [];
    subscribe(
      (event) => {
        received.push(event);
      },
      { fileHash: "aaa111" },
    );
    emit(aHashEvent);
    emit(bHashEvent);
    expect(received).toEqual([aHashEvent]);
  });

  it("does not match a different hash that shares a prefix", () => {
    const received: IngestEvent[] = [];
    subscribe(
      (event) => {
        received.push(event);
      },
      { fileHash: "aaa" },
    );
    // The hash separator `-` prevents `aaa` from matching `aaa111-...`.
    emit(aHashEvent);
    expect(received).toEqual([]);
  });

  it("isolates two concurrent scoped subscribers", () => {
    const a: IngestEvent[] = [];
    const b: IngestEvent[] = [];
    subscribe(
      (event) => {
        a.push(event);
      },
      { fileHash: "aaa111" },
    );
    subscribe(
      (event) => {
        b.push(event);
      },
      { fileHash: "bbb222" },
    );
    emit(aHashEvent);
    emit(bHashEvent);
    expect(a).toEqual([aHashEvent]);
    expect(b).toEqual([bHashEvent]);
  });

  it("delivers file-error events when the file matches the scoped hash", () => {
    const received: IngestEvent[] = [];
    subscribe(
      (event) => {
        received.push(event);
      },
      { fileHash: "aaa111" },
    );
    const errorEvent: IngestEvent = {
      kind: "file-error",
      file: "aaa111-report.csv",
      message: "boom",
    };
    emit(errorEvent);
    expect(received).toEqual([errorEvent]);
  });

  it("unsubscribes a scoped handler cleanly", () => {
    const received: IngestEvent[] = [];
    const unsubscribe = subscribe(
      (event) => {
        received.push(event);
      },
      { fileHash: "aaa111" },
    );
    unsubscribe();
    emit(aHashEvent);
    expect(received).toEqual([]);
  });

  it("treats an unscoped subscriber as a fan-out (default behavior)", () => {
    const received: IngestEvent[] = [];
    subscribe((event) => {
      received.push(event);
    });
    emit(aHashEvent);
    emit(bHashEvent);
    expect(received).toEqual([aHashEvent, bHashEvent]);
  });
});

// Regression for the Next.js dev bundle-splitting bug: `/api/ingest` and
// `/api/upload` were getting separate copies of this module, so a SSE
// subscriber registered through copy A never saw events emitted through copy B
// — the upload UI sat forever on "Starting…". Pinning `subscribers` on
// `globalThis` makes the singleton survive parallel module evaluation.
describe("event bus singleton across module instances", () => {
  it("preserves subscribers when the module is re-evaluated", async () => {
    vi.resetModules();
    const copyA = await import("./events");
    copyA.__resetEventBusForTests();
    const received: IngestEvent[] = [];
    copyA.subscribe((event) => {
      received.push(event);
    });

    // Force a fresh evaluation of the same source file. In Next.js dev this
    // happens implicitly when separate route bundles compile.
    vi.resetModules();
    const copyB = await import("./events");
    copyB.emit(sampleEvent);

    expect(received).toEqual([sampleEvent]);
    copyA.__resetEventBusForTests();
  });
});
