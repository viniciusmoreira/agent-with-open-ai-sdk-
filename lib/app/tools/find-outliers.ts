import { tool } from "ai";
import { z } from "zod";

import { getAllCsvRows } from "@/lib/app/csv-row-cache";
import { flagOutliers } from "@/lib/domain/csv/outliers";
import type { BidRow, OutlierResult } from "@/lib/domain/types";

export const findOutliersInputSchema = z
  .object({
    threshold: z.number().positive().max(10).optional(),
    minPeers: z.number().int().positive().max(1000).optional(),
  })
  .strict();

export type FindOutliersInput = z.infer<typeof findOutliersInputSchema>;

const DESCRIPTION = [
  "Flags bid rows whose unit price deviates from peer bids on the same itemNo + unit by more than a threshold (default 15%).",
  "Operates only on the parsed CSV — never on PDF documents.",
  "Returns each flagged row with: groupMean (leave-one-out peer mean), groupCount, and a signed deviation fraction (positive = above peers, negative = below).",
  "Use this tool whenever the user asks about pricing anomalies, outliers, suspicious bids, or items priced unusually high or low.",
  "Optional inputs: threshold (default 0.15) and minPeers (default 3; groups with fewer rows are skipped).",
].join("\n");

export type FindOutliersDeps = {
  listRows?: () => readonly BidRow[];
};

export function createFindOutliersTool(deps: FindOutliersDeps = {}) {
  const listRows = deps.listRows ?? getAllCsvRows;
  return tool({
    description: DESCRIPTION,
    inputSchema: findOutliersInputSchema,
    execute: async (input): Promise<OutlierResult> => {
      const rows = listRows();
      const options: { threshold?: number; minPeers?: number } = {};
      if (input.threshold !== undefined) options.threshold = input.threshold;
      if (input.minPeers !== undefined) options.minPeers = input.minPeers;
      return flagOutliers(rows, options);
    },
  });
}
