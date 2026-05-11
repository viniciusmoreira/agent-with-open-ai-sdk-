export type UploadFileKind = "csv" | "pdf";

export type UploadFileStatus =
  | "uploading"
  | "ingesting"
  | "cached"
  | "done"
  | "error";

export type UploadProgress =
  | { kind: "csv-rows"; rows: number }
  | { kind: "pdf-pages"; page: number; total: number; path: "text" | "vision" };

export type UploadFileEntry = {
  id: string;
  name: string;
  kind: UploadFileKind;
  status: UploadFileStatus;
  fileHash?: string;
  progress?: UploadProgress;
  unmapped?: string[];
  errorMessage?: string;
  chunks?: number;
};
