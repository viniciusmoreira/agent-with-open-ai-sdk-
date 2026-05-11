export type ToolResultRecord = {
  toolName: string;
  output: unknown;
};

export type SourceRefRecord =
  | { type: "csv-row"; file?: string; rowId: number }
  | { type: "pdf-page"; file: string; page: number; chunkIndex?: number };

export function extractSourceRefs(
  toolResults: readonly ToolResultRecord[],
): SourceRefRecord[] {
  const refs: SourceRefRecord[] = [];
  for (const tr of toolResults) {
    const out = tr.output;
    if (out === null || typeof out !== "object") continue;
    const o = out as {
      rows?: ReadonlyArray<{ rowId?: unknown }>;
      flagged?: ReadonlyArray<{ rowId?: unknown }>;
      chunks?: ReadonlyArray<{ sourceRef?: unknown }>;
    };
    if (Array.isArray(o.rows)) {
      for (const row of o.rows) {
        if (typeof row?.rowId === "number") {
          refs.push({ type: "csv-row", rowId: row.rowId });
        }
      }
    }
    if (Array.isArray(o.flagged)) {
      for (const row of o.flagged) {
        if (typeof row?.rowId === "number") {
          refs.push({ type: "csv-row", rowId: row.rowId });
        }
      }
    }
    if (Array.isArray(o.chunks)) {
      for (const chunk of o.chunks) {
        const ref = chunk?.sourceRef;
        if (!ref || typeof ref !== "object") continue;
        const r = ref as Record<string, unknown>;
        if (r.type === "csv-row" && typeof r.rowId === "number") {
          refs.push({
            type: "csv-row",
            rowId: r.rowId,
            file: typeof r.file === "string" ? r.file : undefined,
          });
        } else if (
          r.type === "pdf-page" &&
          typeof r.file === "string" &&
          typeof r.page === "number"
        ) {
          refs.push({ type: "pdf-page", file: r.file, page: r.page });
        }
      }
    }
  }
  return refs;
}

export class SmokeAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeAssertionError";
  }
}

export function assertHasCitations(
  label: string,
  toolResults: readonly ToolResultRecord[],
): void {
  const refs = extractSourceRefs(toolResults);
  if (refs.length === 0) {
    throw new SmokeAssertionError(
      `[${label}] expected at least one sourceRef citation, got none across ${toolResults.length} tool result(s)`,
    );
  }
}

export function assertHasOutlier(toolResult: ToolResultRecord): void {
  if (toolResult.toolName !== "find_outliers") {
    throw new SmokeAssertionError(
      `assertHasOutlier expected a find_outliers result, got "${toolResult.toolName}"`,
    );
  }
  const out = toolResult.output;
  if (out === null || typeof out !== "object") {
    throw new SmokeAssertionError(
      "find_outliers output is missing or not an object",
    );
  }
  const flagged = (out as { flagged?: unknown }).flagged;
  if (!Array.isArray(flagged) || flagged.length === 0) {
    throw new SmokeAssertionError(
      "find_outliers did not flag any rows from the provided CSV",
    );
  }
}

export const SPEC_QUESTIONS: ReadonlyArray<{
  label: string;
  question: string;
  expectTool?: string;
}> = [
  {
    label: "top-N expensive items",
    question:
      "What are the five most expensive items by extended amount in the bid tabulation? Cite each row.",
    expectTool: "query_bids",
  },
  {
    label: "deviation outliers",
    question:
      "Are any unit prices unusually high or low compared to peer bids? Use a 15% threshold and explain each flagged row.",
    expectTool: "find_outliers",
  },
  {
    label: "drainage plan-set query",
    question:
      "What does the plan set say about drainage? Quote the relevant text with page citations.",
    expectTool: "search_documents",
  },
  {
    label: "key-quantities summary",
    question:
      "Summarize the key quantities in the bid by unit (LS, CY, TON, SY, LF, EA, ACRE). Cite rows.",
    expectTool: "query_bids",
  },
];
