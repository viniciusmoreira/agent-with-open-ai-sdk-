import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const README_PATH = path.join(REPO_ROOT, "README.md");

const REQUIRED_SECTIONS = [
  "Setup",
  "Brief compliance",
  "Architecture decisions",
  "Trade-offs",
  "What I'd change with more time",
  "Smoke evidence",
];

async function readReadme(): Promise<string> {
  return readFile(README_PATH, "utf8");
}

describe("README section presence", () => {
  it.each(REQUIRED_SECTIONS)("contains an H2 section '%s'", async (section) => {
    const readme = await readReadme();
    const headings = readme
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());
    expect(headings).toContain(section);
  });
});

describe("README brief-compliance — embeddings.create isolation", () => {
  it("only appears in lib/adapters/embeddings/openai.ts under lib/", async () => {
    const offenders: string[] = [];
    const allowed = path.join("lib", "adapters", "embeddings", "openai.ts");
    await walk(path.join(REPO_ROOT, "lib"));
    expect(offenders).toEqual([]);

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
          continue;
        }
        const source = await readFile(full, "utf8");
        if (!/embeddings\.create\b/.test(source)) continue;
        const rel = path.relative(REPO_ROOT, full);
        if (rel === allowed) continue;
        offenders.push(rel);
      }
    }
  });
});
