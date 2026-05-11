import { tool } from "ai";
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
  "  - top_n_by_amount: returns the rows with the largest extAmt (extended amount). Accepts optional `n` (default 5).",
  "  - total_by_project: sums extAmt across rows whose projectId matches the supplied `project` (case-insensitive exact match).",
  "  - rows_by_bidder: returns rows whose bidder contains the supplied `bidder` substring (case-insensitive).",
  "  - rows_by_item: returns rows whose itemNo matches the supplied `itemNo` (case-insensitive exact).",
  "Each returned row carries its `rowId` so callers can render citations. Prefer this tool over search_documents for any question about rankings, sums, prices, bidders, or item numbers.",
].join("\n");

export type QueryBidsDeps = {
  listRows?: () => readonly BidRow[];
};

export function createQueryBidsTool(deps: QueryBidsDeps = {}) {
  const listRows = deps.listRows ?? getAllCsvRows;
  return tool({
    description: DESCRIPTION,
    inputSchema: queryBidsInputSchema,
    execute: async (input): Promise<QueryBidsResult> => {
      const rows = listRows();
      if (rows.length === 0) {
        return {
          summary: "No CSV bid data has been ingested yet.",
          rows: [],
        };
      }
      return runQuery(input, rows);
    },
  });
}

export function runQuery(
  input: QueryBidsInput,
  rows: readonly BidRow[],
): QueryBidsResult {
  switch (input.operation) {
    case "top_n_by_amount": {
      const n = input.n ?? DEFAULT_TOP_N;
      const result = topNByAmount(rows, n);
      return {
        summary: `Top ${result.length} row(s) by extended amount.`,
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
      const matched = rowsByBidder(rows, input.bidder);
      return {
        summary: `${matched.length} row(s) match bidder '${input.bidder}'.`,
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
      const matched = rowsByItem(rows, input.itemNo);
      return {
        summary: `${matched.length} row(s) match itemNo '${input.itemNo}'.`,
        rows: matched.slice(0, MAX_RESULT_ROWS).map(projectRow),
      };
    }
  }
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
