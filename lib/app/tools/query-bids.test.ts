import { afterEach, describe, expect, it } from "vitest";

import {
  clearCsvRowCache,
  setCsvRows,
} from "@/lib/app/csv-row-cache";
import type { BidRow, ParseResult } from "@/lib/domain/types";

import {
  createQueryBidsTool,
  queryBidsInputSchema,
  runQuery,
  type QueryBidsResult,
} from "./query-bids";

const NOOP_OPTIONS = {
  toolCallId: "test-call",
  messages: [] as never[],
};

function makeRow(
  rowId: number,
  overrides: Partial<BidRow> &
    Pick<BidRow, "itemNo" | "unit" | "unitPrice" | "bidder">,
): BidRow {
  const qty = overrides.qty ?? 1;
  return {
    rowId,
    projectId: "P1",
    itemDesc: `DESC ${overrides.itemNo}`,
    qty,
    extAmt: overrides.unitPrice * qty,
    raw: {},
    ...overrides,
  };
}

const FIXTURE_ROWS: BidRow[] = [
  makeRow(1, { itemNo: "100", unit: "LS", unitPrice: 10, bidder: "BLYTHE CONSTRUCTION, INC.", projectId: "PA", extAmt: 100 }),
  makeRow(2, { itemNo: "200", unit: "CY", unitPrice: 20, bidder: "BLYTHE CONSTRUCTION, INC.", projectId: "PA", extAmt: 200 }),
  makeRow(3, { itemNo: "300", unit: "TON", unitPrice: 30, bidder: "REA CONTRACTING", projectId: "PB", extAmt: 300 }),
  makeRow(4, { itemNo: "100", unit: "LS", unitPrice: 40, bidder: "REA CONTRACTING", projectId: "PA", extAmt: 400 }),
  makeRow(5, { itemNo: "400", unit: "SY", unitPrice: 50, bidder: "ANSON CONSTRUCTION", projectId: "PB", extAmt: 500 }),
];

function fixtureParseResult(rows: BidRow[]): ParseResult {
  return {
    rows,
    columnMap: {
      projectId: "PROJECT",
      itemNo: "ITEM",
      itemDesc: "DESC",
      unit: "UNIT",
      qty: "QTY",
      unitPrice: "UNIT_PR",
      bidder: "BIDDER",
    },
    unmapped: [],
    errors: [],
  };
}

async function execute(
  tool: ReturnType<typeof createQueryBidsTool>,
  input: unknown,
): Promise<QueryBidsResult> {
  const parsed = queryBidsInputSchema.parse(input);
  if (!tool.execute) throw new Error("tool.execute missing");
  const result = await tool.execute(parsed, NOOP_OPTIONS);
  return result as QueryBidsResult;
}

afterEach(() => {
  clearCsvRowCache();
});

describe("query_bids tool — input schema (strict)", () => {
  it("rejects an unknown field", () => {
    const parsed = queryBidsInputSchema.safeParse({
      operation: "top_n_by_amount",
      foo: "bar",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing operation", () => {
    const parsed = queryBidsInputSchema.safeParse({ n: 3 });
    expect(parsed.success).toBe(false);
  });

  it("accepts the four documented operations", () => {
    for (const op of [
      "top_n_by_amount",
      "total_by_project",
      "rows_by_bidder",
      "rows_by_item",
    ] as const) {
      expect(queryBidsInputSchema.safeParse({ operation: op }).success).toBe(true);
    }
  });
});

describe("query_bids tool — execute via injected rows", () => {
  it("returns five rows sorted by extAmt descending for top_n_by_amount n=5", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, { operation: "top_n_by_amount", n: 5 });
    expect(result.rows.map((r) => r.rowId)).toEqual([5, 4, 3, 2, 1]);
    expect(result.rows.every((r) => typeof r.rowId === "number")).toBe(true);
  });

  it("defaults to top 5 when n is omitted", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, { operation: "top_n_by_amount" });
    expect(result.rows).toHaveLength(5);
  });

  it("filters by bidder substring (case-insensitive)", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "rows_by_bidder",
      bidder: "BLYTHE",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([1, 2]);
  });

  it("sums extAmt for total_by_project", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "total_by_project",
      project: "PA",
    });
    expect(result.summary).toContain("700");
    expect(result.rows.map((r) => r.rowId)).toEqual([1, 2, 4]);
  });

  it("returns matching rows for rows_by_item (exact, case-insensitive)", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "rows_by_item",
      itemNo: "100",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([1, 4]);
  });

  it("returns a no-data summary when no rows are cached", async () => {
    const tool = createQueryBidsTool({ listRows: () => [] });
    const result = await execute(tool, { operation: "top_n_by_amount", n: 3 });
    expect(result.rows).toEqual([]);
    expect(result.summary).toMatch(/no.*csv/i);
  });

  it("returns a missing-field summary when total_by_project receives no project", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    // bypass schema to exercise the runtime guard (schema marks project optional)
    const result = await execute(tool, { operation: "total_by_project" });
    expect(result.rows).toEqual([]);
    expect(result.summary).toMatch(/missing/i);
  });
});

describe("query_bids tool — default listRows reads csv-row-cache", () => {
  it("reads the module-level CSV row cache when no listRows is injected", async () => {
    setCsvRows("hash-a", fixtureParseResult(FIXTURE_ROWS));
    const tool = createQueryBidsTool();
    const result = await execute(tool, { operation: "top_n_by_amount", n: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.rowId).toBe(5);
  });
});

describe("query_bids tool — result shape (TechSpec BidQueryResult)", () => {
  it("returns exactly { summary, rows } with the documented row keys", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, { operation: "top_n_by_amount", n: 1 });
    expect(Object.keys(result).sort()).toEqual(["rows", "summary"]);
    const [row] = result.rows;
    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual(
      ["bidder", "extAmt", "itemDesc", "itemNo", "qty", "rowId", "unit", "unitPrice"].sort(),
    );
  });
});

describe("runQuery", () => {
  it("is a pure function that delegates to the domain", () => {
    const result = runQuery(
      { operation: "rows_by_bidder", bidder: "REA" },
      FIXTURE_ROWS,
    );
    expect(result.rows.map((r) => r.rowId)).toEqual([3, 4]);
  });
});
