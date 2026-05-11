import { afterEach, describe, expect, it } from "vitest";

import { clearCsvRowCache, setCsvRows } from "@/lib/app/csv-row-cache";
import type { BidRow, OutlierResult, ParseResult } from "@/lib/domain/types";

import { createFindOutliersTool, findOutliersInputSchema } from "./find-outliers";

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

// Group of 4 rows on (itemNo=100, unit=LS); row 4 is a clear outlier.
const FIXTURE_ROWS: BidRow[] = [
  makeRow(1, { itemNo: "100", unit: "LS", unitPrice: 100, bidder: "A" }),
  makeRow(2, { itemNo: "100", unit: "LS", unitPrice: 105, bidder: "B" }),
  makeRow(3, { itemNo: "100", unit: "LS", unitPrice: 95, bidder: "C" }),
  makeRow(4, { itemNo: "100", unit: "LS", unitPrice: 500, bidder: "D" }),
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
  tool: ReturnType<typeof createFindOutliersTool>,
  input: unknown,
): Promise<OutlierResult> {
  const parsed = findOutliersInputSchema.parse(input);
  if (!tool.execute) throw new Error("tool.execute missing");
  return (await tool.execute(parsed, NOOP_OPTIONS)) as OutlierResult;
}

afterEach(() => {
  clearCsvRowCache();
});

describe("find_outliers tool — input schema (strict)", () => {
  it("rejects unknown fields", () => {
    expect(findOutliersInputSchema.safeParse({ threshold: 0.2, foo: 1 }).success).toBe(false);
  });

  it("rejects non-positive threshold and minPeers", () => {
    expect(findOutliersInputSchema.safeParse({ threshold: 0 }).success).toBe(false);
    expect(findOutliersInputSchema.safeParse({ minPeers: 0 }).success).toBe(false);
    expect(findOutliersInputSchema.safeParse({ minPeers: 2.5 }).success).toBe(false);
  });

  it("accepts an empty object (all options default)", () => {
    expect(findOutliersInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("find_outliers tool — execute", () => {
  it("flags the obvious outlier with defaults, returning groupMean/groupCount/deviation", async () => {
    const tool = createFindOutliersTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {});
    expect(result.threshold).toBe(0.15);
    expect(result.minPeers).toBe(3);
    expect(result.flagged.length).toBeGreaterThanOrEqual(1);
    const outlier = result.flagged.find((f) => f.rowId === 4);
    expect(outlier).toBeDefined();
    expect(outlier?.groupCount).toBe(4);
    expect(outlier?.groupMean).toBeGreaterThan(0);
    expect(typeof outlier?.deviation).toBe("number");
    expect(outlier!.deviation).toBeGreaterThan(0.15);
  });

  it("returns zero flags when minPeers is set above any group size", async () => {
    const tool = createFindOutliersTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, { minPeers: 10 });
    expect(result.flagged).toEqual([]);
    expect(result.minPeers).toBe(10);
  });

  it("honours a custom threshold", async () => {
    const tool = createFindOutliersTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, { threshold: 5 });
    expect(result.flagged).toEqual([]);
  });

  it("reads the default csv-row cache when no listRows is injected", async () => {
    setCsvRows("hash-a", fixtureParseResult(FIXTURE_ROWS));
    const tool = createFindOutliersTool();
    const result = await execute(tool, {});
    expect(result.flagged.length).toBeGreaterThan(0);
  });
});

describe("find_outliers tool — result shape (TechSpec OutlierResult)", () => {
  it("returns exactly { threshold, minPeers, flagged } and documented flag keys", async () => {
    const tool = createFindOutliersTool({ listRows: () => FIXTURE_ROWS });
    const result = await execute(tool, {});
    expect(Object.keys(result).sort()).toEqual(["flagged", "minPeers", "threshold"]);
    const flag = result.flagged.find((f) => f.rowId === 4);
    expect(flag).toBeDefined();
    expect(Object.keys(flag!).sort()).toEqual(
      [
        "bidder",
        "deviation",
        "groupCount",
        "groupMean",
        "itemDesc",
        "itemNo",
        "rowId",
        "unit",
        "unitPrice",
      ].sort(),
    );
  });
});
