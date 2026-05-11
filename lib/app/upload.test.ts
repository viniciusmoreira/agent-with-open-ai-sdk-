import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { Chunk } from "@/lib/domain/types";
import type { VectorStorePort } from "@/lib/domain/ports/vector-store-port";

import {
  detectFileKind,
  handleUpload,
  type UploadDeps,
  type UploadIngestFn,
} from "./upload";

const CSV_TEXT =
  "PROJECT_ID,ITEM_NO,ITEM_DESC,UNIT,QTY,UNIT_PR,BIDDER\nA,001,Mobilization,LS,1,1000,ACME\n";
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, // "%PDF-"
  0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3,
]);

function makeStore(initialHas = false): {
  store: VectorStorePort;
  setHas: (v: boolean) => void;
  upserts: Array<{ fileHash: string; chunks: Chunk[] }>;
} {
  let present = initialHas;
  const upserts: Array<{ fileHash: string; chunks: Chunk[] }> = [];
  return {
    upserts,
    setHas: (v) => {
      present = v;
    },
    store: {
      async hydrate() {},
      has() {
        return present;
      },
      async upsert(fileHash, chunks) {
        upserts.push({ fileHash, chunks });
        present = true;
      },
      search() {
        return [];
      },
    },
  };
}

type DispatchedRun = () => Promise<void>;

function makeDeps(
  overrides: Partial<UploadDeps> = {},
): {
  deps: UploadDeps;
  csv: ReturnType<typeof vi.fn>;
  pdf: ReturnType<typeof vi.fn>;
  writes: Array<{ filePath: string; bytes: Uint8Array }>;
  mkdirs: string[];
  runs: DispatchedRun[];
} {
  const csv = vi.fn<UploadIngestFn>(async () => {});
  const pdf = vi.fn<UploadIngestFn>(async () => {});
  const writes: Array<{ filePath: string; bytes: Uint8Array }> = [];
  const mkdirs: string[] = [];
  const runs: DispatchedRun[] = [];
  const deps: UploadDeps = {
    store: makeStore().store,
    ingestCsv: csv,
    ingestPdf: pdf,
    maxBytes: 1024,
    tmpDir: "/tmp/uploads-test",
    mkdir: async (dir) => {
      mkdirs.push(dir);
    },
    writeFile: async (filePath, bytes) => {
      writes.push({ filePath, bytes });
    },
    dispatch: (run) => {
      runs.push(run);
    },
    ...overrides,
  };
  return { deps, csv, pdf, writes, mkdirs, runs };
}

function uploadRequest(
  blob: Blob,
  filename: string,
  field = "file",
): Request {
  const form = new FormData();
  form.set(field, blob, filename);
  return new Request("http://localhost/api/upload", {
    method: "POST",
    body: form,
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("detectFileKind", () => {
  it("identifies PDF magic bytes", () => {
    expect(detectFileKind(PDF_BYTES)).toBe("pdf");
  });

  it("identifies plain CSV text", () => {
    expect(detectFileKind(new TextEncoder().encode(CSV_TEXT))).toBe("csv");
  });

  it("rejects binary blobs with no comma/newline", () => {
    const buf = new Uint8Array(32);
    buf.fill(0xff); // high bytes only — printable ratio passes but no comma/newline
    expect(detectFileKind(buf)).toBeNull();
  });

  it("rejects bytes containing NUL", () => {
    const bytes = new Uint8Array([0x61, 0x00, 0x2c, 0x62]);
    expect(detectFileKind(bytes)).toBeNull();
  });

  it("rejects empty input", () => {
    expect(detectFileKind(new Uint8Array(0))).toBeNull();
  });
});

describe("handleUpload", () => {
  it("returns 400 when no file field is present", async () => {
    const { deps } = makeDeps();
    const form = new FormData();
    form.set("not-a-file", "hi");
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: form,
    });
    const res = await handleUpload(req, deps);
    expect(res.status).toBe(400);
  });

  it("returns 400 when the request body is not multipart", async () => {
    const { deps } = makeDeps();
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({ hi: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await handleUpload(req, deps);
    expect(res.status).toBe(400);
  });

  it("returns 400 when the file is empty", async () => {
    const { deps } = makeDeps();
    const res = await handleUpload(
      uploadRequest(new Blob([]), "empty.csv"),
      deps,
    );
    expect(res.status).toBe(400);
  });

  it("dispatches CSV uploads to ingestCsv and returns fileHash with cached:false", async () => {
    const { deps, csv, pdf, writes, mkdirs, runs } = makeDeps();
    const blob = new Blob([CSV_TEXT], { type: "text/csv" });
    const res = await handleUpload(uploadRequest(blob, "bids.csv"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileHash: string; cached: boolean };
    expect(body.cached).toBe(false);
    expect(body.fileHash).toBe(sha256Hex(new TextEncoder().encode(CSV_TEXT)));
    expect(mkdirs).toEqual(["/tmp/uploads-test"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.filePath).toContain(body.fileHash);
    expect(runs).toHaveLength(1);
    await runs[0]!();
    expect(csv).toHaveBeenCalledTimes(1);
    expect(csv).toHaveBeenCalledWith(writes[0]!.filePath, body.fileHash);
    expect(pdf).not.toHaveBeenCalled();
  });

  it("dispatches PDF uploads to ingestPdf when magic bytes match", async () => {
    const { deps, csv, pdf, runs } = makeDeps();
    const blob = new Blob([PDF_BYTES], { type: "application/pdf" });
    const res = await handleUpload(uploadRequest(blob, "plans.pdf"), deps);
    expect(res.status).toBe(200);
    expect(runs).toHaveLength(1);
    await runs[0]!();
    expect(pdf).toHaveBeenCalledTimes(1);
    expect(csv).not.toHaveBeenCalled();
  });

  it("returns 200 with cached:true and skips dispatch when the hash is already in the store", async () => {
    const storeState = makeStore(true);
    const { deps, csv, pdf, runs, writes } = makeDeps({
      store: storeState.store,
    });
    const blob = new Blob([CSV_TEXT], { type: "text/csv" });
    const res = await handleUpload(uploadRequest(blob, "bids.csv"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileHash: string; cached: boolean };
    expect(body.cached).toBe(true);
    expect(runs).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(csv).not.toHaveBeenCalled();
    expect(pdf).not.toHaveBeenCalled();
  });

  it("returns the same fileHash for two identical-content uploads", async () => {
    const { deps } = makeDeps();
    const a = await handleUpload(
      uploadRequest(new Blob([CSV_TEXT]), "a.csv"),
      deps,
    );
    const b = await handleUpload(
      uploadRequest(new Blob([CSV_TEXT]), "b-different-name.csv"),
      deps,
    );
    const bodyA = (await a.json()) as { fileHash: string };
    const bodyB = (await b.json()) as { fileHash: string };
    expect(bodyA.fileHash).toBe(bodyB.fileHash);
  });

  it("returns 400 when a file named .csv contains binary garbage", async () => {
    const { deps, runs } = makeDeps();
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff]);
    const blob = new Blob([binary], { type: "application/octet-stream" });
    const res = await handleUpload(uploadRequest(blob, "junk.csv"), deps);
    expect(res.status).toBe(400);
    expect(runs).toHaveLength(0);
  });

  it("returns 413 when the upload exceeds maxBytes", async () => {
    const { deps, runs } = makeDeps({ maxBytes: 8 });
    const big = "a,b,c\n".repeat(1000);
    const res = await handleUpload(
      uploadRequest(new Blob([big]), "big.csv"),
      deps,
    );
    expect(res.status).toBe(413);
    expect(runs).toHaveLength(0);
  });

  it("returns 500 when persisting the upload fails", async () => {
    const { deps } = makeDeps({
      writeFile: async () => {
        throw new Error("disk full");
      },
    });
    const res = await handleUpload(
      uploadRequest(new Blob([CSV_TEXT]), "bids.csv"),
      deps,
    );
    expect(res.status).toBe(500);
  });

  it("swallows ingestion errors so the dispatcher does not throw", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { deps, runs } = makeDeps({
      ingestCsv: async () => {
        throw new Error("kaboom");
      },
    });
    const res = await handleUpload(
      uploadRequest(new Blob([CSV_TEXT]), "bids.csv"),
      deps,
    );
    expect(res.status).toBe(200);
    await runs[0]!();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});
