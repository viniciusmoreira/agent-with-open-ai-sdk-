import type { ColumnMap } from "@/lib/domain/types";

type RequiredCanonical =
  | "projectId"
  | "itemNo"
  | "itemDesc"
  | "unit"
  | "qty"
  | "unitPrice"
  | "bidder";

type OptionalCanonical =
  | "county"
  | "letDate"
  | "bidRank"
  | "extAmt"
  | "bidTotal";

export type Canonical = RequiredCanonical | OptionalCanonical;

export const REQUIRED_CANONICALS: readonly RequiredCanonical[] = [
  "projectId",
  "itemNo",
  "itemDesc",
  "unit",
  "qty",
  "unitPrice",
  "bidder",
];

export const OPTIONAL_CANONICALS: readonly OptionalCanonical[] = [
  "county",
  "letDate",
  "bidRank",
  "extAmt",
  "bidTotal",
];

const JW_THRESHOLD = 0.92;

const SYNONYMS: Record<Canonical, readonly string[]> = {
  projectId: ["projectId", "project_id", "ProjectId", "PROJ_ID", "PROJECT", "PROJECT_NUMBER", "PIN"],
  itemNo: ["itemNo", "item_no", "ItemNo", "ITEM_NO", "ITEM_NUMBER", "LINE_ITEM"],
  itemDesc: ["itemDesc", "item_description", "ITEM_DESC", "ITEM_DESCRIPTION", "DESCRIPTION", "DESC"],
  unit: ["unit", "UNIT", "UOM", "UNIT_OF_MEASURE"],
  qty: ["qty", "QTY", "QUANTITY", "PLAN_QTY"],
  unitPrice: ["unitPrice", "unit_price", "UnitPrice", "Unit Price", "UNIT_PR", "UNIT_PRICE", "PRICE"],
  bidder: ["bidder", "BIDDER", "BIDDER_NAME", "VENDOR", "CONTRACTOR"],
  county: ["county", "CNTY", "COUNTY"],
  letDate: ["letDate", "let_date", "LET_DT", "LET_DATE", "LETTING_DATE"],
  bidRank: ["bidRank", "bid_rank", "BID_RANK", "RANK"],
  extAmt: ["extAmt", "ext_amount", "EXT_AMT", "EXTENDED_AMOUNT", "EXT_AMOUNT", "EXTENSION"],
  bidTotal: ["bidTotal", "bid_total", "BID_TOTAL", "TOTAL_BID", "AWARD_TOTAL"],
};

// DOT bid tabulations commonly include the engineer's estimate column. We
// recognize it so it isn't reported as an unmapped header, but the domain does
// not currently expose it as a canonical field. Add more "known-but-unused"
// columns here as they surface.
const IGNORED_SYNONYMS: readonly string[] = [
  "ENG_EST_UNIT_PR",
  "ENG_EST_UNIT_PRICE",
  "ENGINEER_ESTIMATE",
  "ENG_EST",
  "ENG_EST_EXT_AMT",
];

export function normalize(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type ColumnMapResult = {
  columnMap: ColumnMap;
  unmapped: string[];
};

export function buildColumnMap(sourceHeaders: readonly string[]): ColumnMapResult {
  const normalizedSources = sourceHeaders.map((h) => ({
    original: h,
    normalized: normalize(h),
  }));

  const synonymIndex = new Map<string, Canonical>();
  for (const canonical of Object.keys(SYNONYMS) as Canonical[]) {
    for (const synonym of SYNONYMS[canonical]) {
      synonymIndex.set(normalize(synonym), canonical);
    }
  }

  const ignoredIndex = new Set(IGNORED_SYNONYMS.map(normalize));

  const assignedCanonical = new Map<Canonical, string>();
  const consumedSources = new Set<string>();

  for (const { original, normalized } of normalizedSources) {
    if (ignoredIndex.has(normalized)) {
      consumedSources.add(original);
      continue;
    }
    const canonical = synonymIndex.get(normalized);
    if (canonical && !assignedCanonical.has(canonical)) {
      assignedCanonical.set(canonical, original);
      consumedSources.add(original);
    }
  }

  type Candidate = { canonical: Canonical; source: string; score: number };
  const candidates: Candidate[] = [];
  for (const { original, normalized } of normalizedSources) {
    if (consumedSources.has(original)) continue;
    for (const canonical of Object.keys(SYNONYMS) as Canonical[]) {
      if (assignedCanonical.has(canonical)) continue;
      let best = 0;
      for (const synonym of SYNONYMS[canonical]) {
        const score = jaroWinkler(normalized, normalize(synonym));
        if (score > best) best = score;
      }
      if (best >= JW_THRESHOLD) {
        candidates.push({ canonical, source: original, score: best });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    if (assignedCanonical.has(candidate.canonical)) continue;
    if (consumedSources.has(candidate.source)) continue;
    assignedCanonical.set(candidate.canonical, candidate.source);
    consumedSources.add(candidate.source);
  }

  const unmapped: string[] = [];
  for (const { original } of normalizedSources) {
    if (!consumedSources.has(original)) unmapped.push(original);
  }

  const columnMap = {} as ColumnMap;
  for (const [canonical, source] of assignedCanonical) {
    (columnMap as Record<string, string>)[canonical] = source;
  }

  return { columnMap, unmapped };
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(b.length, i + matchWindow + 1);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3;

  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(a.length, b.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}
