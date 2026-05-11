"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export type CsvRowCitation = {
  type: "csv-row";
  rowId: number;
  file?: string;
  label?: string;
};

export type PdfPageCitation = {
  type: "pdf-page";
  file: string;
  page: number;
  label?: string;
};

export type Citation = CsvRowCitation | PdfPageCitation;

export type CitationsProps = {
  citations: readonly Citation[];
};

export function Citations({ citations }: CitationsProps) {
  if (citations.length === 0) return null;
  const csv = citations.filter(isCsv);
  const pdf = citations.filter(isPdf);
  return (
    <div
      className="mt-3 flex flex-col gap-2 border-t border-border pt-2"
      data-testid="citations"
    >
      <div className="text-xs font-medium text-muted-foreground">Sources</div>
      <div className="flex flex-wrap gap-1.5">
        {csv.map((c, i) => (
          <Badge
            key={`csv-${c.rowId}-${i}`}
            variant="secondary"
            data-testid="citation-csv"
          >
            row {c.rowId}
          </Badge>
        ))}
        {pdf.map((c, i) => (
          <PdfPageBadge key={`pdf-${c.file}-${c.page}-${i}`} citation={c} />
        ))}
      </div>
    </div>
  );
}

function PdfPageBadge({ citation }: { citation: PdfPageCitation }) {
  const [open, setOpen] = useState(false);
  const fileShort = shortFile(citation.file);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <Badge
            data-testid="citation-pdf"
            variant="secondary"
            className="cursor-pointer"
          />
        }
      >
        {fileShort}:{citation.page}
      </CollapsibleTrigger>
      <CollapsibleContent
        data-testid="citation-pdf-details"
        className="mt-1 text-xs text-muted-foreground"
      >
        <div>
          File: <span className="font-mono">{citation.file}</span>
        </div>
        <div>Page: {citation.page}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function shortFile(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash >= 0 ? file.slice(slash + 1) : file;
}

function isCsv(c: Citation): c is CsvRowCitation {
  return c.type === "csv-row";
}

function isPdf(c: Citation): c is PdfPageCitation {
  return c.type === "pdf-page";
}

type ToolOutput = {
  rows?: ReadonlyArray<{ rowId?: number }>;
  flagged?: ReadonlyArray<{ rowId?: number }>;
  chunks?: ReadonlyArray<{
    sourceRef?:
      | { type?: "csv-row"; file?: string; rowId?: number }
      | { type?: "pdf-page"; file?: string; page?: number };
  }>;
};

export function extractCitations(
  toolName: string,
  output: unknown,
): Citation[] {
  if (output === null || typeof output !== "object") return [];
  const o = output as ToolOutput;
  const out: Citation[] = [];
  if (toolName === "search_documents" && Array.isArray(o.chunks)) {
    for (const chunk of o.chunks) {
      const ref = chunk?.sourceRef;
      if (!ref || typeof ref !== "object") continue;
      if (
        ref.type === "csv-row" &&
        typeof (ref as { rowId?: number }).rowId === "number"
      ) {
        out.push({
          type: "csv-row",
          rowId: (ref as { rowId: number }).rowId,
          file: (ref as { file?: string }).file,
        });
      } else if (
        ref.type === "pdf-page" &&
        typeof (ref as { page?: number }).page === "number" &&
        typeof (ref as { file?: string }).file === "string"
      ) {
        out.push({
          type: "pdf-page",
          file: (ref as { file: string }).file,
          page: (ref as { page: number }).page,
        });
      }
    }
    return out;
  }
  const rowSources = Array.isArray(o.rows)
    ? o.rows
    : Array.isArray(o.flagged)
      ? o.flagged
      : null;
  if (rowSources) {
    for (const row of rowSources) {
      if (row && typeof row.rowId === "number") {
        out.push({ type: "csv-row", rowId: row.rowId });
      }
    }
  }
  return out;
}
