import "server-only";

import { subscribe } from "@/lib/app/events";
import { handleIngestSse } from "@/lib/app/ingest-sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return handleIngestSse(request, { subscribe });
}
