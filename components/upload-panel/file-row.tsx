"use client";

import { memo } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

import type { UploadFileEntry } from "./types";

export type FileRowProps = {
  file: UploadFileEntry;
};

function FileRowImpl({ file }: FileRowProps) {
  return (
    <div
      data-testid="upload-file-row"
      data-file-id={file.id}
      data-status={file.status}
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline" className="uppercase">
            {file.kind}
          </Badge>
          <span
            className="truncate text-sm font-medium"
            title={file.name}
            data-testid="upload-file-name"
          >
            {file.name}
          </span>
        </div>
        <StatusBadge file={file} />
      </div>

      {file.status === "ingesting" && <IngestingBody file={file} />}

      {file.status === "done" && (
        <div
          data-testid="upload-file-summary"
          className="text-xs text-muted-foreground"
        >
          {summaryFor(file)}
        </div>
      )}

      {file.unmapped && file.unmapped.length > 0 && (
        <Alert
          variant="warning"
          data-testid="upload-file-unmapped"
        >
          <AlertTitle>
            {file.unmapped.length} column
            {file.unmapped.length === 1 ? "" : "s"} not mapped to bid fields
          </AlertTitle>
          <AlertDescription>
            <p>Ignored: {file.unmapped.join(", ")}</p>
            <p className="mt-1 text-xs">
              The agent can still answer semantic questions about these
              rows, but numeric queries (rankings, totals, outliers) will
              only consider columns it recognized.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {file.status === "error" && (
        <Alert variant="destructive" data-testid="upload-file-error">
          <AlertTitle>Could not process this file</AlertTitle>
          <AlertDescription>{plainError(file.errorMessage)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function StatusBadge({ file }: { file: UploadFileEntry }) {
  if (file.status === "cached") {
    return (
      <Badge
        variant="secondary"
        data-testid="upload-file-cached-badge"
        className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      >
        Cached
      </Badge>
    );
  }
  if (file.status === "done") {
    return (
      <Badge variant="secondary" data-testid="upload-file-done-badge">
        Ready
      </Badge>
    );
  }
  if (file.status === "error") {
    return (
      <Badge variant="destructive" data-testid="upload-file-error-badge">
        Error
      </Badge>
    );
  }
  if (file.status === "uploading") {
    return (
      <Badge variant="outline" data-testid="upload-file-uploading-badge">
        Uploading…
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid="upload-file-ingesting-badge">
      Processing…
    </Badge>
  );
}

function IngestingBody({ file }: { file: UploadFileEntry }) {
  const text = progressText(file);
  const ratio = progressRatio(file);
  return (
    <div className="flex flex-col gap-1">
      <Progress
        value={ratio?.value ?? null}
        max={ratio?.max ?? 100}
        className={cn("h-1.5")}
      />
      <span
        data-testid="upload-file-progress-text"
        className="text-xs text-muted-foreground"
      >
        {text}
      </span>
    </div>
  );
}

function summaryFor(file: UploadFileEntry): string {
  if (file.kind === "csv") {
    const rows = file.progress?.kind === "csv-rows" ? file.progress.rows : null;
    if (rows != null) return `Indexed ${rows} rows`;
    return file.chunks != null ? `Indexed ${file.chunks} chunks` : "Indexed";
  }
  if (file.progress?.kind === "pdf-pages") {
    return `Indexed ${file.progress.total} pages`;
  }
  return file.chunks != null ? `Indexed ${file.chunks} chunks` : "Indexed";
}

function progressText(file: UploadFileEntry): string {
  if (!file.progress) return "Starting…";
  if (file.progress.kind === "csv-rows") {
    return `${file.progress.rows} rows`;
  }
  return `${file.progress.page}/${file.progress.total} pages (${file.progress.path})`;
}

function progressRatio(
  file: UploadFileEntry,
): { value: number; max: number } | null {
  if (file.progress?.kind === "pdf-pages") {
    return { value: file.progress.page, max: file.progress.total };
  }
  return null;
}

function plainError(message: string | undefined): string {
  if (!message) return "Something went wrong while reading this file.";
  const oneLine = message.split("\n")[0]?.trim() ?? "";
  if (!oneLine) return "Something went wrong while reading this file.";
  return oneLine;
}

export const FileRow = memo(FileRowImpl);
