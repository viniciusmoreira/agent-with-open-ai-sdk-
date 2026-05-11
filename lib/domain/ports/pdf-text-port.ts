import type { DomainError } from "../types";

export type PdfPageText = {
  page: number;
  text: string;
  usable: boolean;
};

export type PdfTextInput = {
  pdf: Uint8Array;
  file: string;
};

export type PdfTextResult = {
  pages: PdfPageText[];
  errors: DomainError[];
};

export interface PdfTextPort {
  extractPages(input: PdfTextInput): Promise<PdfTextResult>;
}
