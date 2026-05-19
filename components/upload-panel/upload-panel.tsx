"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { IngestEvent } from "@/lib/domain/types";
import type { DocumentSummary } from "@/lib/domain/ports/vector-store-port";

import { FileRow } from "./file-row";
import type { UploadFileEntry, UploadFileKind } from "./types";
import { useIngestStream } from "./use-ingest-stream";
import { useUploadReady } from "./upload-ready-context";

const ACCEPTED_EXTENSIONS = [".csv", ".pdf"] as const;
const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(",");

export type UploadPanelProps = {
  uploadUrl?: string;
  ingestUrl?: string;
  documentsUrl?: string;
};

export function UploadPanel({
  uploadUrl = "/api/upload",
  ingestUrl = "/api/ingest",
  documentsUrl = "/api/documents",
}: UploadPanelProps = {}) {
  const [files, setFiles] = useState<UploadFileEntry[]>([]);
  const [rejection, setRejection] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const { markReady } = useUploadReady();

  const updateFile = useCallback(
    (id: string, patch: Partial<UploadFileEntry>) => {
      setFiles((current) =>
        current.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      );
    },
    [],
  );

  const startUpload = useCallback(
    async (entry: UploadFileEntry, file: File) => {
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(uploadUrl, { method: "POST", body: form });
        const body = (await res.json().catch(() => null)) as
          | { fileHash?: string; cached?: boolean; error?: string }
          | null;
        if (!res.ok || !body || typeof body.fileHash !== "string") {
          updateFile(entry.id, {
            status: "error",
            errorMessage:
              body?.error ?? `Upload failed with status ${res.status}`,
          });
          return;
        }
        const fileHash = body.fileHash;
        const nextStatus = body.cached ? "cached" : "ingesting";
        setFiles((current) => {
          const duplicateExists = current.some(
            (e) => e.id !== entry.id && e.fileHash === fileHash,
          );
          if (duplicateExists) {
            return current.filter((e) => e.id !== entry.id);
          }
          return current.map((e) =>
            e.id === entry.id ? { ...e, status: nextStatus, fileHash } : e,
          );
        });
        if (body.cached) markReady();
      } catch (cause) {
        updateFile(entry.id, {
          status: "error",
          errorMessage:
            cause instanceof Error
              ? cause.message
              : "Network error during upload",
        });
      }
    },
    [markReady, updateFile, uploadUrl],
  );

  const acceptFiles = useCallback(
    (incoming: FileList | File[]) => {
      const arr = Array.from(incoming);
      if (arr.length === 0) return;
      setRejection(null);
      const rejected: string[] = [];
      const accepted: { entry: UploadFileEntry; file: File }[] = [];
      for (const file of arr) {
        const kind = detectKind(file.name);
        if (!kind) {
          rejected.push(file.name);
          continue;
        }
        const entry: UploadFileEntry = {
          id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          kind,
          status: "uploading",
        };
        accepted.push({ entry, file });
      }
      if (accepted.length > 0) {
        setFiles((current) => [...current, ...accepted.map((a) => a.entry)]);
        for (const { entry, file } of accepted) {
          void startUpload(entry, file);
        }
      }
      if (rejected.length > 0) {
        setRejection(
          `Only CSV and PDF files are accepted. Ignored: ${rejected.join(", ")}`,
        );
      }
    },
    [startUpload],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer?.files) {
        acceptFiles(e.dataTransfer.files);
      }
    },
    [acceptFiles],
  );

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) acceptFiles(e.target.files);
      e.target.value = "";
    },
    [acceptFiles],
  );

  const onBrowseClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const onIngestEvent = useCallback(
    (event: IngestEvent) => {
      setFiles((current) => {
        const idx = current.findIndex((f) => matchesEvent(f, event));
        if (idx < 0) return current;
        const next = [...current];
        const target = next[idx]!;
        next[idx] = applyEventToEntry(target, event);
        return next;
      });
      if (event.kind === "file-done") {
        markReady();
      }
    },
    [markReady],
  );

  useIngestStream(onIngestEvent, { url: ingestUrl });

  useEffect(() => {
    let cancelled = false;
    setIsBootstrapping(true);
    void (async () => {
      try {
        const res = await fetch(documentsUrl);
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | { documents?: DocumentSummary[] }
          | null;
        const documents = body?.documents;
        if (cancelled || !Array.isArray(documents) || documents.length === 0) {
          return;
        }
        setFiles((current) => {
          const existing = new Set(
            current
              .map((entry) => entry.fileHash)
              .filter((h): h is string => typeof h === "string"),
          );
          const additions: UploadFileEntry[] = documents
            .filter((d) => !existing.has(d.fileHash))
            .map((d) => ({
              id: `existing-${d.fileHash}`,
              name: d.displayName,
              kind: d.kind,
              status: "cached",
              fileHash: d.fileHash,
              chunks: d.chunks,
            }));
          if (additions.length === 0) return current;
          return [...additions, ...current];
        });
        markReady();
      } catch {
      } finally {
        if (!cancelled) setIsBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentsUrl, markReady]);

  return (
    <Card data-testid="upload-panel" className="w-full">
      <CardHeader>
        <CardTitle className="text-sm">Upload bid data &amp; plans</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          data-testid="upload-dropzone"
          data-drag-over={isDragOver ? "true" : "false"}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          className={cn(
            "flex flex-col items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 p-4 text-center text-sm text-muted-foreground transition-colors",
            isDragOver && "border-primary bg-primary/10 text-foreground",
          )}
        >
          <p>Drop a CSV or PDF here</p>
          <p className="text-xs">CSV bid tabulations, PDF plans or specs</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onBrowseClick}
          >
            Choose files
          </Button>
          <input
            ref={inputRef}
            id={inputId}
            data-testid="upload-input"
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="sr-only"
            onChange={onInputChange}
          />
        </div>

        {rejection && (
          <div
            data-testid="upload-rejection"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-200"
          >
            {rejection}
          </div>
        )}

        {isBootstrapping && files.length === 0 && (
          <div
            data-testid="upload-bootstrap-loading"
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
            <span>Loading previously ingested documents…</span>
          </div>
        )}

        {files.length > 0 && (
          <div
            data-testid="upload-file-list"
            className="flex flex-col gap-2"
          >
            {files.map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function detectKind(name: string): UploadFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

function matchesEvent(file: UploadFileEntry, event: IngestEvent): boolean {
  if (!file.fileHash) return false;
  return event.file.startsWith(`${file.fileHash}-`);
}

function applyEventToEntry(
  entry: UploadFileEntry,
  event: IngestEvent,
): UploadFileEntry {
  switch (event.kind) {
    case "file-start":
      return entry.status === "cached"
        ? entry
        : { ...entry, status: "ingesting" };
    case "csv-progress":
      return {
        ...entry,
        status: entry.status === "cached" ? entry.status : "ingesting",
        progress: { kind: "csv-rows", rows: event.rows },
      };
    case "page-progress":
      return {
        ...entry,
        status: entry.status === "cached" ? entry.status : "ingesting",
        progress: {
          kind: "pdf-pages",
          page: event.page,
          total: event.total,
          path: event.path,
        },
      };
    case "file-done":
      return {
        ...entry,
        status: event.cached ? "cached" : "done",
        chunks: event.chunks,
        unmapped: event.unmapped ?? entry.unmapped,
      };
    case "file-error":
      return {
        ...entry,
        status: "error",
        errorMessage: event.message,
      };
    default:
      return entry;
  }
}
