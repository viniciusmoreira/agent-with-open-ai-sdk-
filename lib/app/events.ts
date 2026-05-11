import type { IngestEvent } from "@/lib/domain/types";

export type IngestEventHandler = (event: IngestEvent) => void;

export type SubscribeOptions = {
  /**
   * Restrict delivery to events whose `file` field starts with `${fileHash}-`.
   * Upload routes write to `${fileHash}-${baseName}` so this scopes a subscriber
   * to a single upload without leaking events from concurrent ingestions.
   */
  fileHash?: string;
};

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

export function subscribe(
  handler: IngestEventHandler,
  opts?: SubscribeOptions,
): () => void {
  const fileHash = opts?.fileHash;
  const registered: IngestEventHandler = fileHash
    ? (event) => {
        if (event.file.startsWith(`${fileHash}-`)) handler(event);
      }
    : handler;
  subscribers.add(registered);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(registered);
  };
}

export function __resetEventBusForTests(): void {
  subscribers.clear();
}
