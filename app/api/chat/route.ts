import "server-only";

import { z } from "zod";

import { store } from "@/lib/adapters/vector-store/in-memory";
import { hydrateCsvRowCacheFromDisk } from "@/lib/app/ingest-csv";
import { runAgent } from "@/lib/app/agent/run";

export const runtime = "nodejs";

const MAX_MESSAGES = 200;
const MAX_PARTS_PER_MESSAGE = 64;
const MAX_TOTAL_PAYLOAD_CHARS = 200_000;

const uiMessagePartSchema = z
  .object({ type: z.string().min(1) })
  .passthrough();

const uiMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(["user", "assistant"]),
    parts: z.array(uiMessagePartSchema).min(1).max(MAX_PARTS_PER_MESSAGE),
  })
  .passthrough();

// Vercel AI SDK `useChat` (v5+) sends { id, trigger, messages, messageId? }.
// We allow only those four fields and consume only `messages`; the rest is
// metadata for client-side bookkeeping (chat session id, why the request fired,
// the message being regenerated). Strict so any new top-level field upstream
// surfaces here instead of being silently ignored.
const chatBodySchema = z
  .object({
    id: z.string().optional(),
    trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
    messageId: z.string().optional(),
    messages: z.array(uiMessageSchema).min(1).max(MAX_MESSAGES),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const advertised = parseContentLength(request.headers.get("content-length"));
  if (advertised !== null && advertised > MAX_TOTAL_PAYLOAD_CHARS) {
    return jsonError(413, "Chat transcript exceeds the maximum allowed size");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON");
  }
  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "Invalid request body — expected { messages: UIMessage[] }");
  }
  if (transcriptCharSize(parsed.data.messages) > MAX_TOTAL_PAYLOAD_CHARS) {
    return jsonError(413, "Chat transcript exceeds the maximum allowed size");
  }

  await Promise.all([store.hydrate(), hydrateCsvRowCacheFromDisk()]);
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await runAgent({ messages: parsed.data.messages });
  } catch {
    return jsonError(400, "Chat messages could not be converted to model input");
  }
  return result.toUIMessageStreamResponse();
}

function transcriptCharSize(messages: ReadonlyArray<unknown>): number {
  return JSON.stringify(messages).length;
}

function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
