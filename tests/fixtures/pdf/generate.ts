import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildScannedPagePdf, buildTwoPageTextPdf } from "./build";

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const twoPage = await buildTwoPageTextPdf();
  const scanned = await buildScannedPagePdf();
  writeFileSync(resolve(here, "two-page-text.pdf"), twoPage);
  writeFileSync(resolve(here, "scanned-page.pdf"), scanned);
  console.log("wrote fixtures: two-page-text.pdf, scanned-page.pdf");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
