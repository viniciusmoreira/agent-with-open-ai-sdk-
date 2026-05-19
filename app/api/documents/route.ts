import "server-only";

import { store } from "@/lib/adapters/vector-store/in-memory";
import { listDocuments } from "@/lib/app/list-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const documents = await listDocuments({ store });
  return Response.json({ documents });
}
