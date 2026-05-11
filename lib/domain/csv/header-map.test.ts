import { describe, expect, it } from "vitest";

import { buildColumnMap, jaroWinkler, normalize } from "./header-map";

describe("normalize", () => {
  it("treats UNIT_PR, unit_pr, and Unit Pr as the same key", () => {
    expect(normalize("UNIT_PR")).toBe("unitpr");
    expect(normalize("unit_pr")).toBe("unitpr");
    expect(normalize("Unit Pr")).toBe("unitpr");
    expect(normalize("Unit-Pr")).toBe("unitpr");
  });
});

describe("jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    expect(jaroWinkler("unitprice", "unitprice")).toBe(1);
  });

  it("returns 0 for empty input", () => {
    expect(jaroWinkler("", "unit")).toBe(0);
    expect(jaroWinkler("unit", "")).toBe(0);
  });

  it("rewards shared prefixes", () => {
    const close = jaroWinkler("unitprice", "unitpric");
    const distant = jaroWinkler("unitprice", "xyzlmnop");
    expect(close).toBeGreaterThan(distant);
    expect(close).toBeGreaterThan(0.9);
  });
});

describe("buildColumnMap", () => {
  it("maps the canonical headers from the provided sample CSV and ignores the engineer's estimate", () => {
    const headers = [
      "PROJ_ID",
      "LET_DT",
      "CNTY",
      "ITEM_NO",
      "ITEM_DESC",
      "UNIT",
      "QTY",
      "ENG_EST_UNIT_PR",
      "BIDDER",
      "BID_RANK",
      "UNIT_PR",
      "EXT_AMT",
      "BID_TOTAL",
    ];
    const { columnMap, unmapped } = buildColumnMap(headers);
    expect(unmapped).toEqual([]);
    expect(columnMap).toEqual({
      projectId: "PROJ_ID",
      letDate: "LET_DT",
      county: "CNTY",
      itemNo: "ITEM_NO",
      itemDesc: "ITEM_DESC",
      unit: "UNIT",
      qty: "QTY",
      bidder: "BIDDER",
      bidRank: "BID_RANK",
      unitPrice: "UNIT_PR",
      extAmt: "EXT_AMT",
      bidTotal: "BID_TOTAL",
    });
  });

  it("resolves the renamed UnitPrice header without manual intervention", () => {
    const headers = ["PROJ_ID", "ITEM_NO", "ITEM_DESC", "UNIT", "QTY", "BIDDER", "UnitPrice"];
    const { columnMap, unmapped } = buildColumnMap(headers);
    expect(columnMap.unitPrice).toBe("UnitPrice");
    expect(unmapped).toEqual([]);
  });

  it("reports unrecognized headers in `unmapped`", () => {
    const headers = [
      "PROJ_ID",
      "ITEM_NO",
      "ITEM_DESC",
      "UNIT",
      "QTY",
      "BIDDER",
      "UNIT_PR",
      "WEATHER_NOTES",
    ];
    const { columnMap, unmapped } = buildColumnMap(headers);
    expect(unmapped).toEqual(["WEATHER_NOTES"]);
    expect(columnMap.unitPrice).toBe("UNIT_PR");
  });

  it("falls back to Jaro-Winkler for near-miss headers", () => {
    const headers = ["PROJ_ID", "ITEM_NO", "ITEM_DESCRIPTON", "UNIT", "QTY", "BIDDER", "UNIT_PR"];
    const { columnMap, unmapped } = buildColumnMap(headers);
    expect(columnMap.itemDesc).toBe("ITEM_DESCRIPTON");
    expect(unmapped).toEqual([]);
  });

  it("does not claim a canonical twice when two source headers are similar", () => {
    const headers = ["PROJ_ID", "ITEM_NO", "ITEM_DESC", "UNIT", "QTY", "BIDDER", "UNIT_PR", "UNIT_PRICE"];
    const { columnMap, unmapped } = buildColumnMap(headers);
    expect(columnMap.unitPrice).toBeDefined();
    expect(unmapped.length).toBe(1);
    const claimed = columnMap.unitPrice;
    const leftover = ["UNIT_PR", "UNIT_PRICE"].filter((h) => h !== claimed);
    expect(unmapped).toEqual(leftover);
  });

  it("leaves a required canonical undefined when no source header matches", () => {
    const headers = ["PROJ_ID", "ITEM_NO", "ITEM_DESC", "UNIT", "QTY", "BIDDER"];
    const { columnMap } = buildColumnMap(headers);
    expect(columnMap.unitPrice).toBeUndefined();
  });
});
