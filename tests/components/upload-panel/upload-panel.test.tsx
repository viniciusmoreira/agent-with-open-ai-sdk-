// @vitest-environment jsdom
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { UploadPanel } from "@/components/upload-panel/upload-panel";
import {
  UploadReadyProvider,
  useUploadReady,
} from "@/components/upload-panel/upload-ready-context";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<
    string,
    Set<(e: MessageEvent<string>) => void>
  >();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.closed = true;
  }
  emit(payload: unknown) {
    const data =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    const event = new MessageEvent<string>("message", { data });
    for (const fn of this.listeners.get("message") ?? []) fn(event);
  }
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
const originalEventSource = (globalThis as { EventSource?: unknown })
  .EventSource;

let fetchMock: Mock;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

function ReadyProbe() {
  const { ready } = useUploadReady();
  return <span data-testid="ready-probe">{ready ? "yes" : "no"}</span>;
}

function renderPanel() {
  return render(
    <UploadReadyProvider>
      <UploadPanel />
      <ReadyProbe />
    </UploadReadyProvider>,
  );
}

function dropFiles(files: File[]) {
  const dropzone = screen.getByTestId("upload-dropzone");
  fireEvent.drop(dropzone, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

function currentSource(): MockEventSource {
  const s = MockEventSource.instances.at(-1);
  if (!s) throw new Error("no EventSource opened");
  return s;
}

describe("UploadPanel", () => {
  it("rejects files whose extension is neither .csv nor .pdf", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ fileHash: "h", cached: false }));
    renderPanel();
    const png = new File([new Uint8Array([1, 2, 3])], "logo.png", {
      type: "image/png",
    });
    dropFiles([png]);
    expect(screen.getByTestId("upload-rejection")).toHaveTextContent(
      /Only CSV and PDF/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a dropped CSV to /api/upload as multipart form data", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ fileHash: "abc123", cached: false }),
    );
    renderPanel();
    const csv = new File(["a,b\n1,2"], "bids.csv", { type: "text/csv" });
    dropFiles([csv]);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/upload");
    expect((init as RequestInit).method).toBe("POST");
    const body = (init as RequestInit).body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBe(csv);
  });

  it("renders the cached badge without progress when the server returns cached: true", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ fileHash: "deadbeef", cached: true }),
    );
    renderPanel();
    const csv = new File(["a,b\n1,2"], "bids.csv", { type: "text/csv" });
    dropFiles([csv]);
    await waitFor(() => {
      expect(screen.getByTestId("upload-file-cached-badge")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("upload-file-progress-text")).toBeNull();
    expect(screen.getByTestId("ready-probe")).toHaveTextContent("yes");
  });

  it("renders csv-progress events as a row count", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ fileHash: "csv1", cached: false }),
    );
    renderPanel();
    const csv = new File(["a,b\n1,2"], "bids.csv", { type: "text/csv" });
    dropFiles([csv]);
    await waitFor(() => {
      expect(
        screen.getByTestId("upload-file-ingesting-badge"),
      ).toBeInTheDocument();
    });
    act(() => {
      currentSource().emit({
        kind: "csv-progress",
        file: "csv1-bids.csv",
        rows: 240,
      });
    });
    expect(screen.getByTestId("upload-file-progress-text")).toHaveTextContent(
      "240 rows",
    );
  });

  it("renders page-progress events as X/Y pages with the path", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ fileHash: "pdf1", cached: false }),
    );
    renderPanel();
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "plans.pdf", {
      type: "application/pdf",
    });
    dropFiles([pdf]);
    await waitFor(() => {
      expect(
        screen.getByTestId("upload-file-ingesting-badge"),
      ).toBeInTheDocument();
    });
    act(() => {
      currentSource().emit({
        kind: "page-progress",
        file: "pdf1-plans.pdf",
        page: 3,
        total: 8,
        path: "text",
      });
    });
    expect(screen.getByTestId("upload-file-progress-text")).toHaveTextContent(
      "3/8 pages (text)",
    );
  });

  it("renders a plain-language error and no stack trace on file-error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ fileHash: "csv2", cached: false }),
    );
    renderPanel();
    const csv = new File(["a,b\n1,2"], "bids.csv", { type: "text/csv" });
    dropFiles([csv]);
    await waitFor(() => {
      expect(
        screen.getByTestId("upload-file-ingesting-badge"),
      ).toBeInTheDocument();
    });
    act(() => {
      currentSource().emit({
        kind: "file-error",
        file: "csv2-bids.csv",
        message:
          "Failed to embed: API rate limit\n    at handler (/abs/path.js:42)",
      });
    });
    const error = screen.getByTestId("upload-file-error");
    expect(error).toHaveTextContent("Failed to embed: API rate limit");
    expect(error.textContent).not.toMatch(/\/abs\/path\.js/);
  });

  it("flips ready to true on the first file-done event and surfaces unmapped headers", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ fileHash: "csv3", cached: false }),
    );
    renderPanel();
    const csv = new File(["a,b\n1,2"], "bids.csv", { type: "text/csv" });
    dropFiles([csv]);
    await waitFor(() => {
      expect(
        screen.getByTestId("upload-file-ingesting-badge"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("ready-probe")).toHaveTextContent("no");
    act(() => {
      currentSource().emit({
        kind: "file-done",
        file: "csv3-bids.csv",
        chunks: 42,
        cached: false,
        unmapped: ["MYSTERY"],
      });
    });
    expect(screen.getByTestId("ready-probe")).toHaveTextContent("yes");
    expect(screen.getByTestId("upload-file-done-badge")).toBeInTheDocument();
    expect(screen.getByTestId("upload-file-unmapped")).toHaveTextContent(
      /MYSTERY/,
    );
  });

  it("surfaces a server-side error message when /api/upload returns non-ok", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Upload exceeds limit" }, { status: 413 }),
    );
    renderPanel();
    const csv = new File(["a,b\n1,2"], "bids.csv", { type: "text/csv" });
    dropFiles([csv]);
    await waitFor(() => {
      expect(screen.getByTestId("upload-file-error")).toHaveTextContent(
        "Upload exceeds limit",
      );
    });
  });
});
