import { describe, expect, it } from "vitest";

import type { BidRow } from "@/lib/domain/types";

import {
  rowsByBidder,
  rowsByItem,
  topNByAmount,
  totalByProject,
} from "./query";

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

const sample: BidRow[] = [
  makeRow(1, { itemNo: "100", unit: "LS", unitPrice: 10, bidder: "BLYTHE CONSTRUCTION, INC.", projectId: "PA", extAmt: 100 }),
  makeRow(2, { itemNo: "200", unit: "CY", unitPrice: 20, bidder: "BLYTHE CONSTRUCTION, INC.", projectId: "PA", extAmt: 200 }),
  makeRow(3, { itemNo: "300", unit: "TON", unitPrice: 30, bidder: "REA CONTRACTING", projectId: "PB", extAmt: 300 }),
  makeRow(4, { itemNo: "100", unit: "LS", unitPrice: 40, bidder: "REA CONTRACTING", projectId: "PA", extAmt: 400 }),
  makeRow(5, { itemNo: "400", unit: "SY", unitPrice: 50, bidder: "ANSON CONSTRUCTION", projectId: "PB", extAmt: 500 }),
];

describe("topNByAmount", () => {
  it("returns rows sorted by extAmt descending and truncates to n", () => {
    const result = topNByAmount(sample, 3);
    expect(result.map((r) => r.rowId)).toEqual([5, 4, 3]);
  });

  it("returns an empty array for n <= 0", () => {
    expect(topNByAmount(sample, 0)).toEqual([]);
    expect(topNByAmount(sample, -1)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const before = sample.map((r) => r.rowId);
    topNByAmount(sample, 10);
    expect(sample.map((r) => r.rowId)).toEqual(before);
  });
});

describe("totalByProject", () => {
  it("sums extAmt across rows whose projectId matches case-insensitively", () => {
    const result = totalByProject(sample, "pa");
    expect(result.total).toBe(100 + 200 + 400);
    expect(result.rows.map((r) => r.rowId)).toEqual([1, 2, 4]);
  });

  it("returns zero total and empty rows for an unmatched project", () => {
    expect(totalByProject(sample, "PZ")).toEqual({ total: 0, rows: [] });
  });

  it("returns zero for an empty project string", () => {
    expect(totalByProject(sample, "   ")).toEqual({ total: 0, rows: [] });
  });
});

describe("rowsByBidder", () => {
  it("returns rows whose bidder contains the substring case-insensitively", () => {
    const result = rowsByBidder(sample, "BLYTHE");
    expect(result.map((r) => r.rowId)).toEqual([1, 2]);
  });

  it("matches partial substrings", () => {
    const result = rowsByBidder(sample, "rea");
    expect(result.map((r) => r.rowId)).toEqual([3, 4]);
  });

  it("returns empty for a blank query", () => {
    expect(rowsByBidder(sample, " ")).toEqual([]);
  });
});

describe("rowsByItem", () => {
  it("returns rows whose itemNo matches exactly (case-insensitive)", () => {
    const result = rowsByItem(sample, "100");
    expect(result.map((r) => r.rowId)).toEqual([1, 4]);
  });

  it("does not match substrings", () => {
    expect(rowsByItem(sample, "10")).toEqual([]);
  });
});
