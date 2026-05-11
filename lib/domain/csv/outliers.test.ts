import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { BidRow } from "@/lib/domain/types";

import { flagOutliers } from "./outliers";
import { parseBids } from "./parse";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function fixture(p: string): string {
  return readFileSync(path.join(repoRoot, p), "utf8");
}

function makeRow(
  rowId: number,
  overrides: Partial<BidRow> & Pick<BidRow, "itemNo" | "unit" | "unitPrice">,
): BidRow {
  return {
    rowId,
    projectId: "P1",
    itemDesc: overrides.itemDesc ?? "ITEM",
    bidder: overrides.bidder ?? `BIDDER_${rowId}`,
    qty: overrides.qty ?? 1,
    extAmt: overrides.extAmt ?? overrides.unitPrice,
    raw: overrides.raw ?? {},
    ...overrides,
  };
}

describe("flagOutliers", () => {
  it("flags a row whose unit price exceeds the peer mean by more than the default threshold", () => {
    const rows: BidRow[] = [
      makeRow(1, { itemNo: "100", unit: "LS", unitPrice: 100 }),
      makeRow(2, { itemNo: "100", unit: "LS", unitPrice: 100 }),
      makeRow(3, { itemNo: "100", unit: "LS", unitPrice: 130 }),
    ];
    const result = flagOutliers(rows);
    expect(result.threshold).toBe(0.15);
    expect(result.minPeers).toBe(3);
    expect(result.flagged).toHaveLength(1);
    const flag = result.flagged[0]!;
    expect(flag.rowId).toBe(3);
    expect(flag.unitPrice).toBe(130);
    expect(flag.groupMean).toBe(100);
    expect(flag.groupCount).toBe(3);
    expect(flag.deviation).toBeCloseTo(0.3, 10);
  });

  it("skips groups with fewer rows than minPeers", () => {
    const rows: BidRow[] = [
      makeRow(1, { itemNo: "200", unit: "CY", unitPrice: 50 }),
      makeRow(2, { itemNo: "200", unit: "CY", unitPrice: 5000 }),
    ];
    const result = flagOutliers(rows);
    expect(result.flagged).toEqual([]);
  });

  it("treats the threshold as strict — exactly 0.15 is not flagged, 0.151 is", () => {
    const atBoundary: BidRow[] = [
      makeRow(1, { itemNo: "300", unit: "TON", unitPrice: 100 }),
      makeRow(2, { itemNo: "300", unit: "TON", unitPrice: 100 }),
      makeRow(3, { itemNo: "300", unit: "TON", unitPrice: 115 }),
    ];
    expect(flagOutliers(atBoundary).flagged).toEqual([]);

    const justOver: BidRow[] = [
      makeRow(1, { itemNo: "300", unit: "TON", unitPrice: 100 }),
      makeRow(2, { itemNo: "300", unit: "TON", unitPrice: 100 }),
      makeRow(3, { itemNo: "300", unit: "TON", unitPrice: 115.1 }),
    ];
    const justOverFlags = flagOutliers(justOver).flagged;
    expect(justOverFlags).toHaveLength(1);
    expect(justOverFlags[0]?.rowId).toBe(3);
  });

  it("emits a signed deviation for below-mean outliers", () => {
    const rows: BidRow[] = [
      makeRow(1, { itemNo: "400", unit: "SY", unitPrice: 100 }),
      makeRow(2, { itemNo: "400", unit: "SY", unitPrice: 100 }),
      makeRow(3, { itemNo: "400", unit: "SY", unitPrice: 100 }),
      makeRow(4, { itemNo: "400", unit: "SY", unitPrice: 100 }),
      makeRow(5, { itemNo: "400", unit: "SY", unitPrice: 60 }),
    ];
    const result = flagOutliers(rows);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]?.rowId).toBe(5);
    expect(result.flagged[0]?.unitPrice).toBe(60);
    expect(result.flagged[0]?.groupMean).toBe(100);
    expect(result.flagged[0]?.groupCount).toBe(5);
    expect(result.flagged[0]?.deviation).toBeCloseTo(-0.4, 10);
  });

  it("groups by composite key (itemNo, unit) so different units never compare", () => {
    const rows: BidRow[] = [
      makeRow(1, { itemNo: "500", unit: "LS", unitPrice: 100 }),
      makeRow(2, { itemNo: "500", unit: "LS", unitPrice: 100 }),
      makeRow(3, { itemNo: "500", unit: "EA", unitPrice: 1000 }),
      makeRow(4, { itemNo: "500", unit: "EA", unitPrice: 1000 }),
    ];
    expect(flagOutliers(rows).flagged).toEqual([]);
  });

  it("respects a custom threshold that lifts the bar above the deviation", () => {
    const rows: BidRow[] = [
      makeRow(1, { itemNo: "600", unit: "LF", unitPrice: 100 }),
      makeRow(2, { itemNo: "600", unit: "LF", unitPrice: 100 }),
      makeRow(3, { itemNo: "600", unit: "LF", unitPrice: 120 }),
    ];
    const defaults = flagOutliers(rows);
    expect(defaults.flagged).toHaveLength(1);
    const lifted = flagOutliers(rows, { threshold: 0.25 });
    expect(lifted.flagged).toEqual([]);
    expect(lifted.threshold).toBe(0.25);
  });

  it("respects a custom minPeers", () => {
    const rows: BidRow[] = [
      makeRow(1, { itemNo: "700", unit: "ACRE", unitPrice: 100 }),
      makeRow(2, { itemNo: "700", unit: "ACRE", unitPrice: 130 }),
    ];
    expect(flagOutliers(rows).flagged).toEqual([]);
    const relaxed = flagOutliers(rows, { minPeers: 2 });
    expect(relaxed.minPeers).toBe(2);
    expect(relaxed.flagged).toHaveLength(2);
  });

  it("returns an empty result for an empty input", () => {
    expect(flagOutliers([])).toEqual({
      threshold: 0.15,
      minPeers: 3,
      flagged: [],
    });
  });
});

describe("flagOutliers — provided sample CSV", () => {
  it("flags at least one row from the supplied bid tabulation", () => {
    const text = fixture("docs/sample_bid_tabulation.csv");
    const { rows, errors } = parseBids(text);
    expect(errors).toEqual([]);
    const start = performance.now();
    const result = flagOutliers(rows);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(result.flagged.length).toBeGreaterThan(0);
    for (const flag of result.flagged) {
      expect(Math.abs(flag.deviation)).toBeGreaterThan(result.threshold);
      expect(flag.groupCount).toBeGreaterThanOrEqual(result.minPeers);
    }
  });
});
