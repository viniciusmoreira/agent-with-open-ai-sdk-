import "server-only";

import { z } from "zod";

import { store } from "@/lib/adapters/vector-store/in-memory";
import { runAgent } from "@/lib/app/agent/run";

export const runtime = "nodejs";

const chatBodySchema = z
  .object({
    messages: z.array(z.record(z.string(), z.unknown())).min(1),
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

  await store.hydrate();
  const result = await runAgent({ messages: parsed.data.messages });
  return result.toUIMessageStreamResponse();
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
