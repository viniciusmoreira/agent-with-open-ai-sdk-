export type PdfPageText = {
  page: number;
  text: string;
  usable: boolean;
};

export type PdfTextInput = {
  pdf: Uint8Array;
  file: string;
};

export interface PdfTextPort {
  extractPages(input: PdfTextInput): Promise<PdfPageText[]>;
}
