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

  it("scopes peer groups to projectId so a bid in project A is not compared against project B", () => {
    const rows: BidRow[] = [
      makeRow(1, { projectId: "A", itemNo: "900", unit: "LS", unitPrice: 100 }),
      makeRow(2, { projectId: "A", itemNo: "900", unit: "LS", unitPrice: 100 }),
      makeRow(3, { projectId: "A", itemNo: "900", unit: "LS", unitPrice: 130 }),
      makeRow(4, { projectId: "B", itemNo: "900", unit: "LS", unitPrice: 1000 }),
      makeRow(5, { projectId: "B", itemNo: "900", unit: "LS", unitPrice: 1000 }),
    ];
    const result = flagOutliers(rows);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]?.rowId).toBe(3);
    expect(result.flagged[0]?.groupCount).toBe(3);
    expect(result.flagged[0]?.groupMean).toBe(100);
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

  it("does not collide when itemNo and unit both contain spaces (key-collision regression)", () => {
    // "104 01" + "EA"  →  old key "104 01 EA"
    // "104"    + "01 EA" →  old key "104 01 EA"  (same!)
    // With the JSON.stringify fix the two groups are distinct and neither
    // reaches minPeers=3, so no flags should be emitted.
    const rows: BidRow[] = [
      makeRow(1, { itemNo: "104 01", unit: "EA", unitPrice: 100 }),
      makeRow(2, { itemNo: "104 01", unit: "EA", unitPrice: 100 }),
      makeRow(3, { itemNo: "104", unit: "01 EA", unitPrice: 9999 }),
      makeRow(4, { itemNo: "104", unit: "01 EA", unitPrice: 9999 }),
    ];
    expect(flagOutliers(rows, { minPeers: 3 }).flagged).toEqual([]);
    // Also verify the two groups are seen as independent when there are enough
    // peers: flags from "104 01"/"EA" should not include rows from "104"/"01 EA".
    const rowsWithPeers: BidRow[] = [
      makeRow(1, { itemNo: "104 01", unit: "EA", unitPrice: 100 }),
      makeRow(2, { itemNo: "104 01", unit: "EA", unitPrice: 100 }),
      makeRow(3, { itemNo: "104 01", unit: "EA", unitPrice: 200 }),
      makeRow(4, { itemNo: "104", unit: "01 EA", unitPrice: 50 }),
      makeRow(5, { itemNo: "104", unit: "01 EA", unitPrice: 50 }),
      makeRow(6, { itemNo: "104", unit: "01 EA", unitPrice: 50 }),
    ];
    const result = flagOutliers(rowsWithPeers, { minPeers: 3, threshold: 0.15 });
    const flaggedRowIds = result.flagged.map((f) => f.rowId);
    // Row 3 should be flagged (deviation from peers 1 & 2)
    expect(flaggedRowIds).toContain(3);
    // Rows 4-6 are perfectly uniform; none should be flagged
    expect(flaggedRowIds).not.toContain(4);
    expect(flaggedRowIds).not.toContain(5);
    expect(flaggedRowIds).not.toContain(6);
  });

  it("returns an empty result for an empty input", () => {
    expect(flagOutliers([])).toEqual({
      threshold: 0.15,
      minPeers: 3,
      flagged: [],
      total: 0,
    });
  });

  it("sorts flagged rows by |deviation| descending so the strongest signal is first", () => {
    const rows: BidRow[] = [
      makeRow(1, { itemNo: "800", unit: "LS", unitPrice: 100 }),
      makeRow(2, { itemNo: "800", unit: "LS", unitPrice: 100 }),
      makeRow(3, { itemNo: "800", unit: "LS", unitPrice: 100 }),
      makeRow(4, { itemNo: "800", unit: "LS", unitPrice: 130 }),
      makeRow(5, { itemNo: "800", unit: "LS", unitPrice: 500 }),
    ];
    const result = flagOutliers(rows);
    expect(result.flagged.length).toBeGreaterThanOrEqual(2);
    const absDevs = result.flagged.map((f) => Math.abs(f.deviation));
    for (let i = 1; i < absDevs.length; i++) {
      expect(absDevs[i - 1]).toBeGreaterThanOrEqual(absDevs[i]!);
    }
    expect(result.flagged[0]?.rowId).toBe(5);
  });

  it("caps flagged at 50 rows and reports the pre-cap total", () => {
    const rows: BidRow[] = [];
    let rowId = 1;
    // 60 distinct itemNo groups, each with 3 peers; the third peer in every
    // group deviates by 30% (well past the 15% default), producing 60 flags.
    for (let g = 0; g < 60; g++) {
      const itemNo = `OUT_${g}`;
      rows.push(makeRow(rowId++, { itemNo, unit: "LS", unitPrice: 100 }));
      rows.push(makeRow(rowId++, { itemNo, unit: "LS", unitPrice: 100 }));
      rows.push(makeRow(rowId++, { itemNo, unit: "LS", unitPrice: 130 }));
    }
    const result = flagOutliers(rows);
    expect(result.total).toBe(60);
    expect(result.flagged).toHaveLength(50);
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
