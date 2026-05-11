import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_CJS = path.resolve(HERE, "server-only-stub.cjs");

type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: ResolveFilename };
const ORIGINAL_RESOLVE = M._resolveFilename;
M._resolveFilename = function patched(this: unknown, request, ...rest) {
  if (request === "server-only") return STUB_CJS;
  return ORIGINAL_RESOLVE.apply(this, [request, ...rest] as never);
};

Module.register("./server-only-loader.mjs", import.meta.url);

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SPEC_QUESTIONS,
  SmokeAssertionError,
  assertHasCitations,
  assertHasOutlier,
  type ToolResultRecord,
} from "./smoke-helpers";

const REPO_ROOT = path.resolve(HERE, "..");
const CSV_FIXTURE = path.join(REPO_ROOT, "docs", "sample_bid_tabulation.csv");
const PDF_FIXTURE = path.join(REPO_ROOT, "docs", "plans.pdf");

type IngestEvent = {
  kind: string;
  file?: string;
  page?: number;
  total?: number;
  path?: string;
  rows?: number;
  chunks?: number;
  cached?: boolean;
  message?: string;
};

async function sha256Hex(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function logEvent(kind: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ scope: "smoke", kind, ...payload }));
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY is required to run the smoke script. Set it in .env.local or your shell.",
    );
    process.exit(2);
  }

  const { loadEnv } = await import("@/lib/config/env");
  loadEnv();

  const { store } = await import("@/lib/adapters/vector-store/in-memory");
  const { createOpenAIEmbeddings } = await import(
    "@/lib/adapters/embeddings/openai"
  );
  const { createPdfTextLayer } = await import("@/lib/adapters/pdf/text-layer");
  const { createVisionOcr } = await import("@/lib/adapters/pdf/vision-ocr");
  const { ingestCsv } = await import("@/lib/app/ingest-csv");
  const { ingestPdf } = await import("@/lib/app/ingest-pdf");
  const { runAgent } = await import("@/lib/app/agent/run");

  await store.hydrate();

  const embeddings = createOpenAIEmbeddings();
  const pdfText = createPdfTextLayer();
  const ocr = createVisionOcr();

  const csvHash = await sha256Hex(CSV_FIXTURE);
  logEvent("ingest-start", { file: "sample_bid_tabulation.csv" });
  await ingestCsv(
    CSV_FIXTURE,
    csvHash,
    (event: IngestEvent) => logEvent(`csv:${event.kind}`, event as Record<string, unknown>),
    { embeddings, store },
  );

  const pdfHash = await sha256Hex(PDF_FIXTURE);
  logEvent("ingest-start", { file: "plans.pdf" });
  await ingestPdf(
    PDF_FIXTURE,
    pdfHash,
    (event: IngestEvent) => logEvent(`pdf:${event.kind}`, event as Record<string, unknown>),
    { pdfText, ocr, embeddings, store },
  );

  const failures: string[] = [];

  for (const spec of SPEC_QUESTIONS) {
    logEvent("question-start", { label: spec.label, question: spec.question });
    const started = Date.now();
    const message = {
      id: `smoke-${spec.label}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: spec.question }],
    };
    const result = await runAgent({ messages: [message] });

    // Drain the text stream so the run completes and toolResults are populated.
    let answer = "";
    for await (const delta of result.textStream as AsyncIterable<string>) {
      answer += delta;
    }

    const toolResults = await collectToolResults(result);
    const durationMs = Date.now() - started;
    logEvent("question-finished", {
      label: spec.label,
      durationMs,
      toolCalls: toolResults.map((r) => r.toolName),
      answerLength: answer.length,
    });

    try {
      assertHasCitations(spec.label, toolResults);
      if (spec.expectTool === "find_outliers") {
        const outlierResult = toolResults.find(
          (r) => r.toolName === "find_outliers",
        );
        if (!outlierResult) {
          throw new SmokeAssertionError(
            "[deviation outliers] expected the agent to invoke find_outliers",
          );
        }
        assertHasOutlier(outlierResult);
      }
      logEvent("question-pass", { label: spec.label });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(msg);
      logEvent("question-fail", { label: spec.label, error: msg });
    }
  }

  if (failures.length > 0) {
    console.error(`\nSmoke FAILED with ${failures.length} assertion(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nSmoke PASSED for all four spec questions.");
}

async function collectToolResults(result: {
  steps?: PromiseLike<unknown>;
  toolResults?: PromiseLike<unknown>;
}): Promise<ToolResultRecord[]> {
  const out: ToolResultRecord[] = [];
  if (result.steps) {
    const steps = (await result.steps) as unknown;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        const stepResults = (step as { toolResults?: unknown[] }).toolResults;
        if (!Array.isArray(stepResults)) continue;
        for (const r of stepResults) {
          const rec = normalize(r);
          if (rec) out.push(rec);
        }
      }
    }
  }
  if (out.length === 0 && result.toolResults) {
    const raw = (await result.toolResults) as unknown;
    if (Array.isArray(raw)) {
      for (const r of raw) {
        const rec = normalize(r);
        if (rec) out.push(rec);
      }
    }
  }
  return out;
}

function normalize(raw: unknown): ToolResultRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const toolName = typeof r.toolName === "string" ? r.toolName : null;
  if (!toolName) return null;
  const output = "output" in r ? r.output : "result" in r ? r.result : undefined;
  return { toolName, output };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
