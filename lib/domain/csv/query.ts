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

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
