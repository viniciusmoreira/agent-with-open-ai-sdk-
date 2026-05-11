export type OcrPageInput = {
  pageImage: Uint8Array;
  page: number;
};

export type OcrPageResult = {
  text: string;
  cached: boolean;
};

export interface OcrPort {
  extractPageText(input: OcrPageInput): Promise<OcrPageResult>;
}
