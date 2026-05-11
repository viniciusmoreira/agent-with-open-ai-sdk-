import "server-only";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PDFDocumentProxy,
  TextItem,
  TextMarkedContent,
} from "pdfjs-dist/types/src/display/api";

import type { DomainError } from "@/lib/domain/types";
import type {
  PdfPageText,
  PdfTextInput,
  PdfTextPort,
  PdfTextResult,
} from "@/lib/domain/ports/pdf-text-port";

const DEFAULT_PRINTABLE_RATIO = 0.7;

export type PdfTextLayerOptions = {
  /**
   * Minimum ratio of printable characters required to mark a page `usable`.
   * Pages whose ratio falls below the threshold are flagged for Vision OCR.
   */
  printableRatio?: number;
  /** Optional per-page progress hook; invoked after each page is processed. */
  onPage?: (page: PdfPageText) => void;
};

export function createPdfTextLayer(
  options: PdfTextLayerOptions = {},
): PdfTextPort {
  const printableRatio = options.printableRatio ?? DEFAULT_PRINTABLE_RATIO;
  return {
    async extractPages(input: PdfTextInput): Promise<PdfTextResult> {
      return extract(input, printableRatio, options.onPage);
    },
  };
}

async function extract(
  input: PdfTextInput,
  printableRatio: number,
  onPage: PdfTextLayerOptions["onPage"],
): Promise<PdfTextResult> {
  const errors: DomainError[] = [];
  let doc: PDFDocumentProxy;
  try {
    const task = getDocument({
      data: cloneBytes(input.pdf),
      useSystemFonts: false,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (cause) {
    errors.push({
      kind: "pdf",
      message: `failed to open pdf: ${describe(cause)}`,
      file: input.file,
      cause,
    });
    return { pages: [], errors };
  }

  const pages: PdfPageText[] = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await extractOne(doc, pageNum, input.file, printableRatio, errors);
      pages.push(page);
      onPage?.(page);
    }
  } finally {
    await doc.cleanup().catch(() => undefined);
    await doc.destroy().catch(() => undefined);
  }
  return { pages, errors };
}

async function extractOne(
  doc: PDFDocumentProxy,
  pageNum: number,
  file: string,
  printableRatio: number,
  errors: DomainError[],
): Promise<PdfPageText> {
  try {
    const page = await doc.getPage(pageNum);
    try {
      const content = await page.getTextContent({
        includeMarkedContent: false,
        disableNormalization: false,
      });
      const text = joinItems(content.items);
      return {
        page: pageNum,
        text,
        usable: isUsable(text, printableRatio),
      };
    } finally {
      page.cleanup();
    }
  } catch (cause) {
    errors.push({
      kind: "pdf",
      message: `failed to extract page ${pageNum}: ${describe(cause)}`,
      file,
      page: pageNum,
      cause,
    });
    return { page: pageNum, text: "", usable: false };
  }
}

function joinItems(items: Array<TextItem | TextMarkedContent>): string {
  const parts: string[] = [];
  for (const item of items) {
    if (!("str" in item)) continue;
    parts.push(item.str);
    if (item.hasEOL) parts.push("\n");
    else if (item.str.length > 0) parts.push(" ");
  }
  return parts.join("").replace(/[ \t]+\n/g, "\n").trim();
}

export function isUsable(text: string, printableRatio: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const total = trimmed.length;
  const printable = trimmed.match(/[\p{L}\p{N}\p{P}\p{Zs}]/gu)?.length ?? 0;
  return printable / total >= printableRatio;
}

function cloneBytes(src: Uint8Array): Uint8Array {
  // pdfjs takes ownership of the buffer; clone so callers can reuse input.
  const copy = new Uint8Array(src.byteLength);
  copy.set(src);
  return copy;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "unknown error";
}
