import type {
  BidRow,
  OutlierFlag,
  OutlierResult,
} from "@/lib/domain/types";

export type FlagOutliersOptions = {
  threshold?: number;
  minPeers?: number;
};

const DEFAULT_THRESHOLD = 0.15;
const DEFAULT_MIN_PEERS = 3;
const MAX_FLAGS = 50;

export function flagOutliers(
  rows: readonly BidRow[],
  opts: FlagOutliersOptions = {},
): OutlierResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minPeers = opts.minPeers ?? DEFAULT_MIN_PEERS;

  // Scope peer groups to projectId — region/letting/market move prices across projects.
  const groups = new Map<string, BidRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.projectId, row.itemNo, row.unit]);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const flagged: OutlierFlag[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < minPeers) continue;
    const sum = bucket.reduce((acc, r) => acc + r.unitPrice, 0);
    const groupCount = bucket.length;
    for (const row of bucket) {
      const peerCount = groupCount - 1;
      const peerMean = (sum - row.unitPrice) / peerCount;
      if (peerMean === 0) continue;
      const deviation = (row.unitPrice - peerMean) / peerMean;
      if (Math.abs(deviation) > threshold) {
        flagged.push({
          rowId: row.rowId,
          itemNo: row.itemNo,
          itemDesc: row.itemDesc,
          unit: row.unit,
          bidder: row.bidder,
          unitPrice: row.unitPrice,
          groupMean: peerMean,
          groupCount,
          deviation,
        });
      }
    }
  }

  flagged.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
  const total = flagged.length;
  const limited = total > MAX_FLAGS ? flagged.slice(0, MAX_FLAGS) : flagged;
  return { threshold, minPeers, flagged: limited, total };
}
