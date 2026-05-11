import { z } from "zod";

import { getAllCsvRows } from "@/lib/app/csv-row-cache";
import {
  rowsByBidder,
  rowsByItem,
  topNByAmount,
  totalByProject,
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
    ]),
    n: z.number().int().positive().max(MAX_TOP_N).optional(),
    project: z.string().min(1).optional(),
    bidder: z.string().min(1).optional(),
    itemNo: z.string().min(1).optional(),
  })
  .strict();

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
};

const DESCRIPTION = [
  "Deterministic queries over the parsed bid-tabulation CSV.",
  "Use for structural or numeric questions: ranking by amount, totalling a project, filtering by bidder or item number.",
  "Operations:",
  "  - top_n_by_amount: returns the rows with the largest extAmt (extended amount). Accepts optional `n` (default 5) and optional `project`, `bidder`, `itemNo` filters applied before ranking — pass them to scope the ranking to a single project, bidder, or item.",
  "  - total_by_project: sums extAmt across rows whose projectId matches the supplied `project` (case-insensitive exact match).",
  "  - rows_by_bidder: returns rows whose bidder contains the supplied `bidder` substring (case-insensitive). Optional `itemNo` and `project` narrow the result, so you can answer 'what did Bidder X bid for Item Y?' in one call.",
  "  - rows_by_item: returns rows whose itemNo matches the supplied `itemNo` (case-insensitive exact). Optional `bidder` and `project` narrow the result.",
  "Each returned row carries its `rowId` so callers can render citations. Prefer this tool over search_documents for any question about rankings, sums, prices, bidders, or item numbers.",
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
  switch (input.operation) {
    case "top_n_by_amount": {
      const n = input.n ?? DEFAULT_TOP_N;
      const scoped = filterRows(rows, input);
      const result = topNByAmount(scoped, n);
      const scope = scopeLabel(input);
      return {
        summary: `Top ${result.length} of ${scoped.length} row(s) by extended amount${scope}.`,
        rows: result.map(projectRow),
      };
    }
    case "total_by_project": {
      if (!input.project) {
        return {
          summary: "Missing required field 'project' for total_by_project.",
          rows: [],
        };
      }
      const { total, rows: matched } = totalByProject(rows, input.project);
      return {
        summary: `Total extAmt for project '${input.project}' = ${total} across ${matched.length} row(s).`,
        rows: matched.slice(0, MAX_RESULT_ROWS).map(projectRow),
      };
    }
    case "rows_by_bidder": {
      if (!input.bidder) {
        return {
          summary: "Missing required field 'bidder' for rows_by_bidder.",
          rows: [],
        };
      }
      const primary = rowsByBidder(rows, input.bidder);
      const matched = filterRows(primary, {
        project: input.project,
        itemNo: input.itemNo,
      });
      const scope = scopeLabel({ project: input.project, itemNo: input.itemNo });
      return {
        summary: `${matched.length} row(s) match bidder '${input.bidder}'${scope}.`,
        rows: matched.slice(0, MAX_RESULT_ROWS).map(projectRow),
      };
    }
    case "rows_by_item": {
      if (!input.itemNo) {
        return {
          summary: "Missing required field 'itemNo' for rows_by_item.",
          rows: [],
        };
      }
      const primary = rowsByItem(rows, input.itemNo);
      const matched = filterRows(primary, {
        project: input.project,
        bidder: input.bidder,
      });
      const scope = scopeLabel({ project: input.project, bidder: input.bidder });
      return {
        summary: `${matched.length} row(s) match itemNo '${input.itemNo}'${scope}.`,
        rows: matched.slice(0, MAX_RESULT_ROWS).map(projectRow),
      };
    }
  }
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
