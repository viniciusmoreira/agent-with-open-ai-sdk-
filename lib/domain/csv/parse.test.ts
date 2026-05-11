import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { coerceNumber, parseBids } from "./parse";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function fixture(p: string): string {
  return readFileSync(path.join(repoRoot, p), "utf8");
}

describe("parseBids — provided sample CSV", () => {
  const text = fixture("docs/sample_bid_tabulation.csv");
  const result = parseBids(text);

  it("maps every canonical column and leaves no unmapped headers", () => {
    expect(result.unmapped).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.columnMap).toMatchObject({
      projectId: "PROJ_ID",
      itemNo: "ITEM_NO",
      itemDesc: "ITEM_DESC",
      unit: "UNIT",
      qty: "QTY",
      unitPrice: "UNIT_PR",
      bidder: "BIDDER",
      county: "CNTY",
      letDate: "LET_DT",
      bidRank: "BID_RANK",
      extAmt: "EXT_AMT",
      bidTotal: "BID_TOTAL",
    });
  });

  it("produces rows with 1-based ids and preserves the raw record", () => {
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]?.rowId).toBe(1);
    expect(result.rows[0]?.raw.PROJ_ID).toBe("0676350");
    expect(result.rows[0]?.bidder).toBe("BLYTHE CONSTRUCTION, INC.");
  });

  it("matches the data-row count of the source file", () => {
    const dataLines = text.split(/\r?\n/).slice(1).filter((l) => l.trim().length > 0);
    expect(result.rows.length).toBe(dataLines.length);
  });
});

describe("parseBids — renamed-header fixture", () => {
  it("resolves UnitPrice and coerces the numeric value", () => {
    const text = fixture("tests/fixtures/csv/renamed-headers.csv");
    const result = parseBids(text);
    expect(result.unmapped).toEqual([]);
    expect(result.columnMap.unitPrice).toBe("UnitPrice");
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.unitPrice).toBe(16500);
  });
});

describe("parseBids — extra-unmappable fixture", () => {
  it("reports the unrecognized header but still parses the remaining rows", () => {
    const text = fixture("tests/fixtures/csv/extra-unmappable.csv");
    const result = parseBids(text);
    expect(result.unmapped).toEqual(["WEATHER_NOTES"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.itemNo).toBe("1031000");
  });
});

describe("parseBids — missing extAmt column", () => {
  it("recomputes extAmt as unitPrice * qty", () => {
    const csv =
      "PROJ_ID,ITEM_NO,ITEM_DESC,UNIT,QTY,UNIT_PR,BIDDER\n" +
      "P1,1031000,MOBILIZATION,LS,2,1500,ACME\n" +
      "P1,2033000,EXCAVATION,CY,10,107.15,ACME\n";
    const result = parseBids(csv);
    expect(result.columnMap.extAmt).toBeUndefined();
    expect(result.rows[0]?.extAmt).toBe(3000);
    expect(result.rows[1]?.extAmt).toBeCloseTo(1071.5, 5);
  });
});

describe("parseBids — currency-string coercion", () => {
  it("parses '$1,234.56' to 1234.56", () => {
    const csv =
      "PROJ_ID,ITEM_NO,ITEM_DESC,UNIT,QTY,UNIT_PR,BIDDER\n" +
      "P1,1031000,MOBILIZATION,LS,1,\"$1,234.56\",ACME\n";
    const result = parseBids(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.unitPrice).toBe(1234.56);
  });

  it("produces a parse DomainError and skips the row when a critical numeric is '-' or empty", () => {
    const csv =
      "PROJ_ID,ITEM_NO,ITEM_DESC,UNIT,QTY,UNIT_PR,BIDDER\n" +
      "P1,1031000,MOBILIZATION,LS,1,-,ACME\n" +
      "P1,2033000,EXCAVATION,CY,,107.15,ACME\n" +
      "P1,3059900,MAINTENANCE STONE,TON,2.9,46.5,ACME\n";
    const result = parseBids(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.itemNo).toBe("3059900");
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.kind).toBe("parse");
    expect(result.errors.every((e) => e.kind === "parse")).toBe(true);
  });
});

describe("parseBids — required-column guard", () => {
  it("returns a parse error and no rows when a required column is missing", () => {
    const csv =
      "PROJ_ID,ITEM_NO,ITEM_DESC,UNIT,QTY,BIDDER\n" + // no unit price
      "P1,1031000,MOBILIZATION,LS,1,ACME\n";
    const result = parseBids(csv);
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("parse");
    expect(result.errors[0]?.message).toContain("unitPrice");
  });
});

describe("coerceNumber", () => {
  it("strips dollar signs, commas, and whitespace", () => {
    expect(coerceNumber("$1,234.56")).toBe(1234.56);
    expect(coerceNumber(" 42 ")).toBe(42);
    expect(coerceNumber("-12.5")).toBe(-12.5);
  });

  it("returns null for empty input or sentinel '-'", () => {
    expect(coerceNumber("")).toBeNull();
    expect(coerceNumber("-")).toBeNull();
    expect(coerceNumber("not-a-number")).toBeNull();
  });
});
