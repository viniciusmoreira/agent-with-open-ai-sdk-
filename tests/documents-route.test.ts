import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hydrateMock = vi.fn(async () => {});
const listMock = vi.fn(() => [] as Array<Record<string, unknown>>);

vi.mock("@/lib/adapters/vector-store/in-memory", () => ({
  store: {
    hydrate: hydrateMock,
    has: () => false,
    upsert: async () => {},
    search: () => [],
    list: listMock,
  },
}));

async function importRoute() {
  vi.resetModules();
  return import("@/app/api/documents/route");
}

beforeEach(() => {
  hydrateMock.mockClear();
  listMock.mockReset();
  listMock.mockReturnValue([]);
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /api/documents", () => {
  it("hydrates the store and returns an empty list when nothing is ingested", async () => {
    const { GET } = await importRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: unknown[] };
    expect(body).toEqual({ documents: [] });
    expect(hydrateMock).toHaveBeenCalledTimes(1);
  });

  it("returns the documents the store reports", async () => {
    listMock.mockReturnValue([
      {
        fileHash: "h1",
        kind: "csv",
        displayName: "bids.csv",
        chunks: 10,
      },
      {
        fileHash: "h2",
        kind: "pdf",
        displayName: "plans.pdf",
        chunks: 3,
      },
    ]);
    const { GET } = await importRoute();
    const res = await GET();
    const body = (await res.json()) as {
      documents: Array<{ fileHash: string; kind: string }>;
    };
    expect(body.documents.map((d) => d.fileHash)).toEqual(["h1", "h2"]);
    expect(body.documents[0]?.kind).toBe("csv");
  });
});
