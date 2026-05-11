import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hydrateMock = vi.fn(async () => {});
const runAgentMock = vi.fn();

vi.mock("@/lib/adapters/vector-store/in-memory", () => ({
  store: {
    hydrate: hydrateMock,
    has: () => false,
    upsert: async () => {},
    search: () => [],
  },
}));

vi.mock("@/lib/app/agent/run", () => ({
  runAgent: runAgentMock,
}));

const ORIGINAL_ENV = { ...process.env };

async function importRoute() {
  vi.resetModules();
  return import("@/app/api/chat/route");
}

function fakeResponse(): Response {
  return new Response("ok", { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function makeStreamResult(): { toUIMessageStreamResponse: ReturnType<typeof vi.fn> } {
  const response = fakeResponse();
  return {
    toUIMessageStreamResponse: vi.fn(() => response),
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, OPENAI_API_KEY: "sk-test-route" };
  hydrateMock.mockClear();
  runAgentMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/chat — request validation", () => {
  it("rejects a non-JSON body with HTTP 400", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("rejects a body missing 'messages' with HTTP 400", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/messages/i);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("rejects an empty messages array with HTTP 400", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("rejects unknown top-level fields with HTTP 400", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user" }], extra: "nope" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat — happy path", () => {
  it("awaits store.hydrate() before invoking runAgent", async () => {
    const order: string[] = [];
    hydrateMock.mockImplementationOnce(async () => {
      order.push("hydrate");
    });
    runAgentMock.mockImplementationOnce(async () => {
      order.push("runAgent");
      return makeStreamResult();
    });
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      headers: { "Content-Type": "application/json" },
    });
    await POST(req);
    expect(order).toEqual(["hydrate", "runAgent"]);
  });

  it("returns the Response produced by result.toUIMessageStreamResponse()", async () => {
    const result = makeStreamResult();
    runAgentMock.mockResolvedValueOnce(result);
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(result.toUIMessageStreamResponse).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
  });

  it("passes the validated messages array through to runAgent", async () => {
    runAgentMock.mockResolvedValueOnce(makeStreamResult());
    const { POST } = await importRoute();
    const messages = [
      { role: "user", content: "Top five most expensive items?" },
    ];
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages }),
      headers: { "Content-Type": "application/json" },
    });
    await POST(req);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0]![0]).toEqual({ messages });
  });
});
