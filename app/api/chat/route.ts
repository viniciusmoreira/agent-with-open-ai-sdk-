import "server-only";

import { z } from "zod";

import { store } from "@/lib/adapters/vector-store/in-memory";
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

const chatBodySchema = z
  .object({
    messages: z.array(uiMessageSchema).min(1).max(MAX_MESSAGES),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
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

  await store.hydrate();
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

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
