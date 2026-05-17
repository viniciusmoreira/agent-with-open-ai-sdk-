import type { BidRow } from "@/lib/domain/types";

export function topNByAmount(rows: readonly BidRow[], n: number): BidRow[] {
  if (n <= 0) return [];
  return [...rows].sort((a, b) => b.extAmt - a.extAmt).slice(0, n);
}

export function totalByProject(
  rows: readonly BidRow[],
  project: string,
): { total: number; rows: BidRow[] } {
  const needle = normalize(project);
  if (needle === "") return { total: 0, rows: [] };
  const matches = rows.filter((row) => normalize(row.projectId) === needle);
  const total = matches.reduce((acc, row) => acc + row.extAmt, 0);
  return { total, rows: matches };
}

export function rowsByBidder(
  rows: readonly BidRow[],
  bidder: string,
): BidRow[] {
  const needle = normalize(bidder);
  if (needle === "") return [];
  return rows.filter((row) => normalize(row.bidder).includes(needle));
}

export function rowsByItem(rows: readonly BidRow[], itemNo: string): BidRow[] {
  const needle = normalize(itemNo);
  if (needle === "") return [];
  return rows.filter((row) => normalize(row.itemNo) === needle);
}

export type UnitSummary = {
  unit: string;
  count: number;
  totalQty: number;
  totalExtAmt: number;
  sampleRowIds: number[];
};

/**
 * Groups rows by their `unit` column and reports per-group counts and totals.
 * `sampleRowIds` carries up to three example rowIds per group so the agent can
 * cite at least one row when summarizing — without that, "summarize by unit"
 * questions return totals but no rowId for the smoke citation assertion.
 */
export function summaryByUnit(rows: readonly BidRow[]): UnitSummary[] {
  const groups = new Map<string, UnitSummary>();
  for (const row of rows) {
    const unit = row.unit.trim() || "(blank)";
    let g = groups.get(unit);
    if (!g) {
      g = {
        unit,
        count: 0,
        totalQty: 0,
        totalExtAmt: 0,
        sampleRowIds: [],
      };
      groups.set(unit, g);
    }
    g.count++;
    g.totalQty += row.qty;
    g.totalExtAmt += row.extAmt;
    if (g.sampleRowIds.length < 3) g.sampleRowIds.push(row.rowId);
  }
  return [...groups.values()].sort((a, b) => b.totalExtAmt - a.totalExtAmt);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
