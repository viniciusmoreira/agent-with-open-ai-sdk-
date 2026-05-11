import { PDFDocument, StandardFonts } from "pdf-lib";

export async function buildTwoPageTextPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p1 = pdf.addPage([300, 200]);
  p1.setFont(font);
  p1.setFontSize(14);
  p1.drawText("Hello textual PDF page one.", { x: 30, y: 150 });
  p1.drawText("Concrete pavement repair.", { x: 30, y: 120 });
  const p2 = pdf.addPage([300, 200]);
  p2.setFont(font);
  p2.setFontSize(14);
  p2.drawText("Page two follows in order.", { x: 30, y: 150 });
  p2.drawText("Asphalt overlay section.", { x: 30, y: 120 });
  return pdf.save({ useObjectStreams: false });
}

export async function buildScannedPagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]);
  return pdf.save({ useObjectStreams: false });
}
