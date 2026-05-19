import { z } from "zod";

import { getAllCsvRows } from "@/lib/app/csv-row-cache";
import {
  rowsByBidder,
  rowsByItem,
  summaryByUnit,
  topNByAmount,
  totalByProject,
  type UnitSummary,
} from "@/lib/domain/csv/query";
import type { BidRow } from "@/lib/domain/types";

const DEFAULT_TOP_N = 5;
const MAX_TOP_N = 100;
const MAX_RESULT_ROWS = 200;

export const queryBidsInputSchema = z
  .object({
    operation: z.enum([
      "top_n_by_amount",
      "total_by_project",
      "rows_by_bidder",
      "rows_by_item",
      "summary_by_unit",
    ]),
    n: z.number().int().positive().max(MAX_TOP_N).optional(),
    project: z.string().min(1).optional(),
    bidder: z.string().min(1).optional(),
    itemNo: z.string().min(1).optional(),
  })
  .strict();

// The agent treats optional filters as "match anything" placeholders when in
// doubt — observed values include ".*", "*", "%", "all", "unknown", "N/A",
// "omit", ".", and bare whitespace. Rejecting these at the schema level
// pushes the LLM into a retry loop where it cycles through synonyms. Accept
// any non-empty string at the boundary and drop the meaningless ones inside
// `execute` instead: a missing filter is the documented "no scope" path.
const WILDCARD_TOKENS = new Set([
  ".*",
  "*",
  "%",
  "all",
  "any",
  "*.*",
  "n/a",
  "na",
  "none",
  "unknown",
  "omit",
  "null",
]);
const ALPHANUMERIC = /[A-Za-z0-9]/;
function meaningfulFilter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!ALPHANUMERIC.test(trimmed)) return undefined;
  if (WILDCARD_TOKENS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

export type QueryBidsInput = z.infer<typeof queryBidsInputSchema>;

export type QueryBidsResultRow = {
  rowId: number;
  bidder: string;
  itemNo: string;
  itemDesc: string;
  unit: string;
  qty: number;
  unitPrice: number;
  extAmt: number;
};

export type QueryBidsResult = {
  summary: string;
  rows: QueryBidsResultRow[];
  // Populated by `summary_by_unit` only. Each entry aggregates the rows whose
  // `unit` column matches; `sampleRowIds` is included in the flat `rows` array
  // above so existing citation extraction keeps working.
  unitGroups?: UnitSummary[];
};

const DESCRIPTION = [
  "Deterministic queries over the parsed bid-tabulation CSV.",
  "Use for structural or numeric questions: ranking by amount, totalling a project, filtering by bidder or item number.",
  "Operations:",
  "  - top_n_by_amount: returns the rows with the largest extAmt (extended amount). Accepts optional `n` (default 5) and optional `project`, `bidder`, `itemNo` filters applied before ranking — pass them to scope the ranking to a single project, bidder, or item.",
  "  - total_by_project: sums extAmt across rows whose projectId matches the supplied `project` (case-insensitive exact match).",
  "  - rows_by_bidder: returns rows whose bidder contains the supplied `bidder` substring (case-insensitive). Optional `itemNo` and `project` narrow the result, so you can answer 'what did Bidder X bid for Item Y?' in one call.",
  "  - rows_by_item: returns rows whose itemNo matches the supplied `itemNo` (case-insensitive exact). Optional `bidder` and `project` narrow the result.",
  "  - summary_by_unit: groups every row by its `unit` column (LS, CY, TON, SY, LF, EA, ACRE, …) and returns per-unit count, totalQty, totalExtAmt, plus up to three sample rowIds per group. Use this for 'summarize key quantities' or 'breakdown by unit of measure' questions — a single call covers all units, so do NOT loop one call per unit.",
  "Each returned row carries its `rowId` so callers can render citations. Prefer this tool over search_documents for any question about rankings, sums, prices, bidders, or item numbers.",
  "Filter usage: `project`, `bidder`, and `itemNo` are OPTIONAL. To rank or list across the whole bid, OMIT them entirely. Do NOT send wildcards like \".*\", \"*\", \"%\", or \"all\" — the tool matches literally, so a wildcard returns 0 rows.",
].join("\n");

export type QueryBidsDeps = {
  listRows?: () => readonly BidRow[];
};

export type QueryBidsTool = {
  description: string;
  inputSchema: typeof queryBidsInputSchema;
  execute: (input: QueryBidsInput, options?: unknown) => Promise<QueryBidsResult>;
};

export function createQueryBidsTool(deps: QueryBidsDeps = {}): QueryBidsTool {
  const listRows = deps.listRows ?? getAllCsvRows;
  return {
    description: DESCRIPTION,
    inputSchema: queryBidsInputSchema,
    execute: async (input) => {
      const rows = listRows();
      if (rows.length === 0) {
        return {
          summary: "No CSV bid data has been ingested yet.",
          rows: [],
        };
      }
      return runQuery(input, rows);
    },
  };
}

export function runQuery(
  input: QueryBidsInput,
  rows: readonly BidRow[],
): QueryBidsResult {
  // Strip filter values that don't carry concrete content. The agent often
  // passes wildcard placeholders for optional fields; treating those as
  // "no filter" matches the description and keeps results deterministic.
  const project = meaningfulFilter(input.project);
  const bidder = meaningfulFilter(input.bidder);
  const itemNo = meaningfulFilter(input.itemNo);
  const filter: RowFilter = { project, bidder, itemNo };

  switch (input.operation) {
    case "top_n_by_amount": {
      const n = input.n ?? DEFAULT_TOP_N;
      const scoped = filterRows(rows, filter);
      const result = topNByAmount(scoped, n);
      const scope = scopeLabel(filter);
      return {
        summary: `Top ${result.length} of ${scoped.length} row(s) by extended amount${scope}.`,
        rows: result.map(projectRow),
      };
    }
    case "total_by_project": {
      if (!project) {
        return {
          summary:
            "Missing required field 'project' for total_by_project (it must contain alphanumeric content).",
          rows: [],
        };
      }
      const { total, rows: matched } = totalByProject(rows, project);
      const trunc = truncationNote(matched.length);
      return {
        summary: `Total extAmt for project '${project}' = ${total} across ${matched.length} row(s)${trunc}.`,
        rows: matched.slice(0, MAX_RESULT_ROWS).map(projectRow),
      };
    }
    case "rows_by_bidder": {
      if (!bidder) {
        return {
          summary:
            "Missing required field 'bidder' for rows_by_bidder (it must contain alphanumeric content).",
          rows: [],
        };
      }
      const primary = rowsByBidder(rows, bidder);
      const matched = filterRows(primary, { project, itemNo });
      const scope = scopeLabel({ project, itemNo });
      const trunc = truncationNote(matched.length);
      return {
        summary: `${matched.length} row(s) match bidder '${bidder}'${scope}${trunc}.`,
        rows: matched.slice(0, MAX_RESULT_ROWS).map(projectRow),
      };
    }
    case "rows_by_item": {
      if (!itemNo) {
        return {
          summary:
            "Missing required field 'itemNo' for rows_by_item (it must contain alphanumeric content).",
          rows: [],
        };
      }
      const primary = rowsByItem(rows, itemNo);
      const matched = filterRows(primary, { project, bidder });
      const scope = scopeLabel({ project, bidder });
      const trunc = truncationNote(matched.length);
      return {
        summary: `${matched.length} row(s) match itemNo '${itemNo}'${scope}${trunc}.`,
        rows: matched.slice(0, MAX_RESULT_ROWS).map(projectRow),
      };
    }
    case "summary_by_unit": {
      const scoped = filterRows(rows, filter);
      const groups = summaryByUnit(scoped);
      const scope = scopeLabel(filter);
      const sampleIds = new Set<number>();
      for (const g of groups) {
        for (const id of g.sampleRowIds) sampleIds.add(id);
      }
      const sampleRows = scoped
        .filter((row) => sampleIds.has(row.rowId))
        .slice(0, MAX_RESULT_ROWS)
        .map(projectRow);
      return {
        summary: `${groups.length} unit group(s) across ${scoped.length} row(s)${scope}.`,
        rows: sampleRows,
        unitGroups: groups,
      };
    }
  }
}

function truncationNote(matchedLength: number): string {
  if (matchedLength <= MAX_RESULT_ROWS) return "";
  return ` (showing first ${MAX_RESULT_ROWS}; ${matchedLength - MAX_RESULT_ROWS} more truncated)`;
}

type RowFilter = {
  project?: string;
  bidder?: string;
  itemNo?: string;
};

function filterRows(rows: readonly BidRow[], filter: RowFilter): BidRow[] {
  const project = normalizeOrUndefined(filter.project);
  const bidder = normalizeOrUndefined(filter.bidder);
  const itemNo = normalizeOrUndefined(filter.itemNo);
  if (!project && !bidder && !itemNo) return [...rows];
  return rows.filter((row) => {
    if (project && normalize(row.projectId) !== project) return false;
    if (itemNo && normalize(row.itemNo) !== itemNo) return false;
    if (bidder && !normalize(row.bidder).includes(bidder)) return false;
    return true;
  });
}

function scopeLabel(filter: RowFilter): string {
  const parts: string[] = [];
  if (filter.project) parts.push(`project '${filter.project}'`);
  if (filter.bidder) parts.push(`bidder '${filter.bidder}'`);
  if (filter.itemNo) parts.push(`itemNo '${filter.itemNo}'`);
  return parts.length === 0 ? "" : ` (scoped to ${parts.join(", ")})`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalize(value);
  return normalized === "" ? undefined : normalized;
}

function projectRow(row: BidRow): QueryBidsResultRow {
  return {
    rowId: row.rowId,
    bidder: row.bidder,
    itemNo: row.itemNo,
    itemDesc: row.itemDesc,
    unit: row.unit,
    qty: row.qty,
    unitPrice: row.unitPrice,
    extAmt: row.extAmt,
  };
}
