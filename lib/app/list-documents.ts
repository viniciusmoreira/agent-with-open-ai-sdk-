import type {
  DocumentSummary,
  VectorStorePort,
} from "@/lib/domain/ports/vector-store-port";

export type ListDocumentsDeps = {
  store: VectorStorePort;
};

export async function listDocuments(
  deps: ListDocumentsDeps,
): Promise<DocumentSummary[]> {
  await deps.store.hydrate();
  return deps.store.list();
}
