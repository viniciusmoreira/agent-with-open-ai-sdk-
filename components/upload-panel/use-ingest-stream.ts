"use client";

import { useEffect, useRef } from "react";

import type { IngestEvent } from "@/lib/domain/types";

export type IngestStreamHandler = (event: IngestEvent) => void;

export type UseIngestStreamOptions = {
  url?: string;
  enabled?: boolean;
};

export function useIngestStream(
  handler: IngestStreamHandler,
  options: UseIngestStreamOptions = {},
): void {
  const { url = "/api/ingest", enabled = true } = options;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }
    const source = new EventSource(url);
    const onMessage = (e: MessageEvent<string>) => {
      const payload = parseIngestEvent(e.data);
      if (payload) handlerRef.current(payload);
    };
    source.addEventListener("message", onMessage);
    return () => {
      source.removeEventListener("message", onMessage);
      source.close();
    };
  }, [url, enabled]);
}

function parseIngestEvent(raw: unknown): IngestEvent | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const kind = (parsed as { kind?: unknown }).kind;
  if (typeof kind !== "string") return null;
  return parsed as IngestEvent;
}
