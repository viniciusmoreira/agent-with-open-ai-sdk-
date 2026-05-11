import "server-only";

import { createOpenAIEmbeddings } from "@/lib/adapters/embeddings/openai";
import { createPdfTextLayer } from "@/lib/adapters/pdf/text-layer";
import { createVisionOcr } from "@/lib/adapters/pdf/vision-ocr";
import { store } from "@/lib/adapters/vector-store/in-memory";
import { getEnv } from "@/lib/config/env";
import { emit } from "@/lib/app/events";
import { hydrateCsvRowCacheFromDisk, ingestCsv } from "@/lib/app/ingest-csv";
import { ingestPdf } from "@/lib/app/ingest-pdf";
import { handleUpload } from "@/lib/app/upload";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  await Promise.all([store.hydrate(), hydrateCsvRowCacheFromDisk()]);
  const embeddings = createOpenAIEmbeddings();
  const pdfText = createPdfTextLayer();
  const ocr = createVisionOcr();

  return handleUpload(request, {
    store,
    maxBytes: getEnv().MAX_UPLOAD_BYTES,
    ingestCsv: (filePath, fileHash) =>
      ingestCsv(filePath, fileHash, emit, { embeddings, store }),
    ingestPdf: (filePath, fileHash) =>
      ingestPdf(filePath, fileHash, emit, {
        pdfText,
        ocr,
        embeddings,
        store,
      }),
  });
}
