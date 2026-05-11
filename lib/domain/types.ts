export type SourceRef =
  | { type: "csv-row"; file: string; rowId: number }
  | { type: "pdf-page"; file: string; page: number; chunkIndex: number };

export type Chunk = {
  id: string;
  text: string;
  vector: Float32Array;
  sourceRef: SourceRef;
};

export type ColumnMap = {
  projectId: string;
  itemNo: string;
  itemDesc: string;
  unit: string;
  qty: string;
  unitPrice: string;
  bidder: string;
  county?: string;
  letDate?: string;
  bidRank?: string;
  extAmt?: string;
  bidTotal?: string;
};

export type BidRow = {
  rowId: number;
  projectId: string;
  county?: string;
  letDate?: string;
  itemNo: string;
  itemDesc: string;
  unit: string;
  qty: number;
  bidder: string;
  bidRank?: number;
  unitPrice: number;
  extAmt: number;
  bidTotal?: number;
  raw: Record<string, string>;
};

export type ParseResult = {
  rows: BidRow[];
  columnMap: ColumnMap;
  unmapped: string[];
  errors: DomainError[];
};

export type OutlierFlag = {
  rowId: number;
  itemNo: string;
  itemDesc: string;
  unit: string;
  bidder: string;
  unitPrice: number;
  groupMean: number;
  groupCount: number;
  deviation: number;
};

export type OutlierResult = {
  threshold: number;
  minPeers: number;
  flagged: OutlierFlag[];
};

export type IngestEvent =
  | { kind: "file-start"; file: string; sizeBytes: number }
  | {
      kind: "page-progress";
      file: string;
      page: number;
      total: number;
      path: "text" | "vision";
    }
  | { kind: "csv-progress"; file: string; rows: number }
  | { kind: "file-done"; file: string; chunks: number; cached: boolean }
  | { kind: "file-error"; file: string; message: string };

export type DomainError =
  | { kind: "parse"; message: string; detail?: unknown }
  | { kind: "embedding"; message: string; cause?: unknown }
  | { kind: "ocr"; message: string; page?: number; cause?: unknown }
  | {
      kind: "pdf";
      message: string;
      file?: string;
      page?: number;
      cause?: unknown;
    }
  | { kind: "vector-store"; message: string; cause?: unknown }
  | { kind: "cache"; message: string; path?: string; cause?: unknown }
  | { kind: "validation"; message: string; field?: string };
