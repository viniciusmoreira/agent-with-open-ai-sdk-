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
let uploadResponse: Response | null;
let documentsResponse: Response;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
  documentsResponse = jsonResponse({ documents: [] });
  uploadResponse = null;
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/documents")) {
      return Promise.resolve(documentsResponse.clone());
    }
    if (!uploadResponse) {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    return Promise.resolve(uploadResponse.clone());
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function setUploadResponse(res: Response) {
  uploadResponse = res;
}

function setDocumentsResponse(res: Response) {
  documentsResponse = res;
}

function uploadFetchCalls(): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return !url.includes("/api/documents");
    })
    .map(([input, init]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return [url, init as RequestInit | undefined];
    });
}

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
    setUploadResponse(jsonResponse({ fileHash: "h", cached: false }));
    renderPanel();
    const png = new File([new Uint8Array([1, 2, 3])], "logo.png", {
      type: "image/png",
    });
    dropFiles([png]);
    expect(screen.getByTestId("upload-rejection")).toHaveTextContent(
      /Only CSV and PDF/,
    );
    expect(uploadFetchCalls()).toHaveLength(0);
  });

  it("posts a dropped CSV to /api/upload as multipart form data", async () => {
    setUploadResponse(jsonResponse({ fileHash: "abc123", cached: false }));
    renderPanel();
    const csv = new File(["a,b\n1,2"], "bids.csv", { type: "text/csv" });
    dropFiles([csv]);
    await waitFor(() => {
      expect(uploadFetchCalls()).toHaveLength(1);
    });
    const [url, init] = uploadFetchCalls()[0]!;
    expect(url).toBe("/api/upload");
    expect(init?.method).toBe("POST");
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBe(csv);
  });

  it("renders the cached badge without progress when the server returns cached: true", async () => {
    setUploadResponse(jsonResponse({ fileHash: "deadbeef", cached: true }));
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
    setUploadResponse(jsonResponse({ fileHash: "csv1", cached: false }));
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
    setUploadResponse(jsonResponse({ fileHash: "pdf1", cached: false }));
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
    setUploadResponse(jsonResponse({ fileHash: "csv2", cached: false }));
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
    setUploadResponse(jsonResponse({ fileHash: "csv3", cached: false }));
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

  it("shows a loading indicator while /api/documents is pending and hides it after the response", async () => {
    let resolveDocs: (res: Response) => void;
    const docsPromise = new Promise<Response>((resolve) => {
      resolveDocs = resolve;
    });
    setDocumentsResponse(jsonResponse({ documents: [] }));
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/documents")) return docsPromise;
      throw new Error(`Unexpected fetch to ${url}`);
    });
    renderPanel();
    expect(screen.getByTestId("upload-bootstrap-loading")).toBeInTheDocument();
    await act(async () => {
      resolveDocs!(jsonResponse({ documents: [] }));
      await docsPromise;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("upload-bootstrap-loading")).toBeNull();
    });
  });

  it("hydrates the file list from /api/documents on mount and marks ready", async () => {
    setDocumentsResponse(
      jsonResponse({
        documents: [
          {
            fileHash: "h1",
            kind: "csv",
            displayName: "bid-tab.csv",
            chunks: 124,
          },
          {
            fileHash: "h2",
            kind: "pdf",
            displayName: "plans.pdf",
            chunks: 6,
          },
        ],
      }),
    );
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("bid-tab.csv")).toBeInTheDocument();
    });
    expect(screen.getByText("plans.pdf")).toBeInTheDocument();
    expect(screen.getAllByTestId("upload-file-cached-badge")).toHaveLength(2);
    expect(screen.getByTestId("ready-probe")).toHaveTextContent("yes");
  });

  it("stays in the empty state when /api/documents returns an empty list", async () => {
    renderPanel();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("upload-file-list")).toBeNull();
    expect(screen.getByTestId("ready-probe")).toHaveTextContent("no");
  });

  it("does not duplicate a document already present in the list", async () => {
    setDocumentsResponse(
      jsonResponse({
        documents: [
          {
            fileHash: "abc123",
            kind: "csv",
            displayName: "bids.csv",
            chunks: 10,
          },
        ],
      }),
    );
    setUploadResponse(jsonResponse({ fileHash: "abc123", cached: true }));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("bids.csv")).toBeInTheDocument();
    });
    const csv = new File(["a,b\n1,2"], "bids.csv", { type: "text/csv" });
    dropFiles([csv]);
    await waitFor(() => {
      expect(screen.getAllByTestId("upload-file-cached-badge").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("bids.csv")).toHaveLength(1);
  });

  it("surfaces a server-side error message when /api/upload returns non-ok", async () => {
    setUploadResponse(
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
