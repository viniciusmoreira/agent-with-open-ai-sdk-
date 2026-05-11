import type { IngestEvent } from "@/lib/domain/types";

export type IngestSseSubscribe = (
  handler: (event: IngestEvent) => void,
) => () => void;

export type IngestSseDeps = {
  subscribe: IngestSseSubscribe;
};

export function handleIngestSse(
  request: Request,
  deps: IngestSseDeps,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let onAbort: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (onAbort) {
          request.signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
      };

      unsubscribe = deps.subscribe((event) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          cleanup();
        }
      });

      // Initial comment frame keeps the connection open through proxies.
      try {
        controller.enqueue(encoder.encode(": ok\n\n"));
      } catch {
        cleanup();
        return;
      }

      onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };

      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener("abort", onAbort);
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (onAbort) {
        request.signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
