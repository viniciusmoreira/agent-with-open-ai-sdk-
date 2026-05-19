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

  it("accepts the five documented operations", () => {
    for (const op of [
      "top_n_by_amount",
      "total_by_project",
      "rows_by_bidder",
      "rows_by_item",
      "summary_by_unit",
    ] as const) {
      expect(queryBidsInputSchema.safeParse({ operation: op }).success).toBe(true);
    }
  });

  it("accepts any non-empty filter string at the schema level", () => {
    // Boundary is permissive on purpose — wildcards are stripped inside
    // execute() so the LLM doesn't get into a retry loop guessing synonyms.
    for (const v of [".*", "all", "unknown", "ALPHA SPACE", "."]) {
      expect(
        queryBidsInputSchema.safeParse({
          operation: "top_n_by_amount",
          project: v,
        }).success,
      ).toBe(true);
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

  // Regression: the LLM frequently fills optional filters with placeholder
  // tokens it doesn't actually intend as scopes. execute() must strip these
  // and return the full result set, NOT an empty one.
  it.each([
    [".*", ".*", ".*"],
    ["*", "*", "*"],
    ["all", "all", "all"],
    ["unknown", "unknown", "unknown"],
    ["N/A", "N/A", "N/A"],
    [" ", " ", " "],
    [".", ".", "."],
    ["omit", "omit", "omit"],
  ])(
    "treats wildcard placeholder project=%s bidder=%s itemNo=%s as no filter and returns the full top-N",
    async (project, bidder, itemNo) => {
      const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
      const result = await execute(tool, {
        operation: "top_n_by_amount",
        n: 5,
        project,
        bidder,
        itemNo,
      });
      expect(result.rows.length).toBe(5);
      expect(result.rows.every((r) => typeof r.rowId === "number")).toBe(true);
    },
  );

  it("summary_by_unit returns grouped totals plus sample rows for citations", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, { operation: "summary_by_unit" });
    expect(result.unitGroups).toBeDefined();
    expect(result.unitGroups!.length).toBe(4);
    expect(result.unitGroups!.map((g) => g.unit)).toEqual([
      "LS",
      "SY",
      "TON",
      "CY",
    ]);
    // Flat `rows` must include at least one rowId per group so the smoke
    // citation extractor finds something to cite.
    const rowIds = new Set(result.rows.map((r) => r.rowId));
    for (const g of result.unitGroups!) {
      for (const id of g.sampleRowIds) {
        expect(rowIds.has(id)).toBe(true);
      }
    }
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

describe("query_bids tool — top_n_by_amount scoping", () => {
  it("scopes ranking to the supplied project", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "top_n_by_amount",
      n: 5,
      project: "PA",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([4, 2, 1]);
    expect(result.summary).toMatch(/project 'PA'/);
  });

  it("scopes ranking to the supplied bidder (substring, case-insensitive)", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "top_n_by_amount",
      n: 3,
      bidder: "rea",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([4, 3]);
  });

  it("scopes ranking by itemNo, returning the highest bid for that item across bidders", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "top_n_by_amount",
      n: 1,
      itemNo: "100",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([4]);
  });

  it("intersects project + bidder filters", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "top_n_by_amount",
      n: 5,
      project: "PA",
      bidder: "BLYTHE",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([2, 1]);
  });

  it("returns no rows when filters match nothing", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "top_n_by_amount",
      n: 5,
      project: "ZZZ",
    });
    expect(result.rows).toEqual([]);
    expect(result.summary).toMatch(/0 of 0 row\(s\)/);
  });
});

describe("query_bids tool — bidder/item intersection", () => {
  it("rows_by_bidder narrows by optional itemNo (answers 'what did Bidder X bid for Item Y?')", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "rows_by_bidder",
      bidder: "REA",
      itemNo: "100",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([4]);
    expect(result.summary).toMatch(/itemNo '100'/);
  });

  it("rows_by_item narrows by optional bidder", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "rows_by_item",
      itemNo: "100",
      bidder: "BLYTHE",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([1]);
  });

  it("rows_by_bidder narrows by optional project", async () => {
    const tool = createQueryBidsTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {
      operation: "rows_by_bidder",
      bidder: "REA",
      project: "PA",
    });
    expect(result.rows.map((r) => r.rowId)).toEqual([4]);
  });
});

describe("query_bids tool — truncation", () => {
  it("returns only MAX_RESULT_ROWS rows and reports the pre-cap total in the summary", async () => {
    const wideRows: BidRow[] = Array.from({ length: 250 }, (_, i) =>
      makeRow(i + 1, {
        itemNo: "777",
        unit: "EA",
        unitPrice: 1,
        bidder: `BIDDER_${i + 1}`,
        projectId: "PA",
        extAmt: 1,
      }),
    );
    const tool = createQueryBidsTool({ listRows: () => wideRows });
    const result = await execute(tool, {
      operation: "rows_by_item",
      itemNo: "777",
    });
    expect(result.rows).toHaveLength(200);
    expect(result.summary).toContain("250 row(s) match itemNo '777'");
    expect(result.summary).toContain("showing first 200");
    expect(result.summary).toContain("50 more truncated");
  });
});
