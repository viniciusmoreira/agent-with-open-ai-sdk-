import Papa from "papaparse";

import type { BidRow, ColumnMap, DomainError, ParseResult } from "@/lib/domain/types";

import { buildColumnMap, REQUIRED_CANONICALS } from "./header-map";

type RawRow = Record<string, string>;

export function parseBids(csvText: string): ParseResult {
  const parsed = Papa.parse<RawRow>(csvText, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  const headers = parsed.meta.fields ?? [];
  const { columnMap, unmapped } = buildColumnMap(headers);
  const errors: DomainError[] = [];

  const missingRequired = REQUIRED_CANONICALS.filter(
    (field) => columnMap[field] === undefined,
  );
  if (missingRequired.length > 0) {
    errors.push({
      kind: "parse",
      message: `Missing required column(s): ${missingRequired.join(", ")}`,
      detail: { missing: missingRequired, headers },
    });
    return { rows: [], columnMap, unmapped, errors };
  }

  const rows: BidRow[] = [];
  let rowId = 0;
  for (const raw of parsed.data) {
    rowId++;
    const result = coerceRow(rowId, raw, columnMap);
    if ("kind" in result) errors.push(result);
    else rows.push(result);
  }

  return { rows, columnMap, unmapped, errors };
}

function coerceRow(
  rowId: number,
  raw: RawRow,
  columnMap: ColumnMap,
): BidRow | DomainError {
  const projectId = readText(raw, columnMap.projectId);
  const itemNo = readText(raw, columnMap.itemNo);
  const itemDesc = readText(raw, columnMap.itemDesc);
  const unit = readText(raw, columnMap.unit);
  const bidder = readText(raw, columnMap.bidder);
  const qty = readNumber(raw, columnMap.qty);
  const unitPrice = readNumber(raw, columnMap.unitPrice);

  const missing: string[] = [];
  if (projectId === null) missing.push("projectId");
  if (itemNo === null) missing.push("itemNo");
  if (itemDesc === null) missing.push("itemDesc");
  if (unit === null) missing.push("unit");
  if (bidder === null) missing.push("bidder");
  if (qty === null) missing.push("qty");
  if (unitPrice === null) missing.push("unitPrice");
  if (
    projectId === null ||
    itemNo === null ||
    itemDesc === null ||
    unit === null ||
    bidder === null ||
    qty === null ||
    unitPrice === null
  ) {
    return {
      kind: "parse",
      message: `Row ${rowId}: unparseable critical field(s) ${missing.join(", ")}`,
      detail: { rowId, missing, raw },
    };
  }

  const extAmtFromSource =
    columnMap.extAmt !== undefined ? readNumber(raw, columnMap.extAmt) : null;
  const extAmt = extAmtFromSource ?? unitPrice * qty;

  const row: BidRow = {
    rowId,
    projectId,
    itemNo,
    itemDesc,
    unit,
    qty,
    bidder,
    unitPrice,
    extAmt,
    raw,
  };

  const county = readOptionalText(raw, columnMap.county);
  if (county !== undefined) row.county = county;
  const letDate = readOptionalText(raw, columnMap.letDate);
  if (letDate !== undefined) row.letDate = letDate;
  const bidRank = readOptionalNumber(raw, columnMap.bidRank);
  if (bidRank !== undefined) row.bidRank = bidRank;
  const bidTotal = readOptionalNumber(raw, columnMap.bidTotal);
  if (bidTotal !== undefined) row.bidTotal = bidTotal;

  return row;
}

function readText(raw: RawRow, sourceHeader: string): string | null {
  const value = raw[sourceHeader];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readOptionalText(
  raw: RawRow,
  sourceHeader: string | undefined,
): string | undefined {
  if (sourceHeader === undefined) return undefined;
  const value = raw[sourceHeader];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readNumber(raw: RawRow, sourceHeader: string): number | null {
  const value = raw[sourceHeader];
  if (value === undefined) return null;
  return coerceNumber(value);
}

function readOptionalNumber(
  raw: RawRow,
  sourceHeader: string | undefined,
): number | undefined {
  if (sourceHeader === undefined) return undefined;
  const value = raw[sourceHeader];
  if (value === undefined) return undefined;
  const n = coerceNumber(value);
  return n === null ? undefined : n;
}

export function coerceNumber(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
