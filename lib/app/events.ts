import type { IngestEvent } from "@/lib/domain/types";

export type IngestEventHandler = (event: IngestEvent) => void;

const subscribers = new Set<IngestEventHandler>();

export function emit(event: IngestEvent): void {
  for (const handler of subscribers) {
    try {
      handler(event);
    } catch (error) {
      console.error(
        JSON.stringify({
          scope: "ingest-events",
          message: "subscriber threw",
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

export function subscribe(handler: IngestEventHandler): () => void {
  subscribers.add(handler);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(handler);
  };
}

export function __resetEventBusForTests(): void {
  subscribers.clear();
}
