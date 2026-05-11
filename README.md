# bid-agent

A question-answering assistant for construction estimators. Ingests a DOT bid-tabulation CSV plus project PDFs, then answers natural-language questions through a single tool-using LLM agent. Every answer cites the CSV row or PDF page it came from.

Built as a take-home submission against `docs/Take Home Test Spec.md`.

## Setup

Target: clone to working chat in under five minutes on Node 20+ with pnpm.

```bash
git clone <repo>
cd agent-with-open-ai-sdk
pnpm install
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY
pnpm dev
```

Open <http://localhost:3000>, drag `docs/sample_bid_tabulation.csv` and `docs/plans.pdf` onto the upload panel, and ask a question once each file shows `done`.

Requirements:

- Node `>=20`, pnpm 10 (project pin: `packageManager: pnpm@10.20.0`).
- An `OPENAI_API_KEY` with access to `text-embedding-3-small`, `gpt-4o`, and `gpt-4o-mini`.
- The provided fixtures under `docs/` ship with the repo — uploading them is one click.

Useful commands:

- `pnpm dev` — start the app (the canonical run path; ADR-002).
- `pnpm test` — Vitest unit + integration suite.
- `pnpm typecheck` — strict TypeScript with `noUncheckedIndexedAccess`.
- `pnpm lint` — ESLint (Next.js flat config).
- `pnpm tsx scripts/smoke-spec-questions.ts` — end-to-end smoke against the four brief example questions (requires `OPENAI_API_KEY`).
- `rm -rf .cache/ tmp/` — single recovery step if anything looks stale (ADR-006).

## Brief compliance

The Take Home Test Spec calls out four hard requirements; here is how each one maps to the code.

- **"Use the OpenAI SDK for embeddings."** The `openai` package is imported in exactly one source file. Verify with:

  ```bash
  grep -rn "embeddings\.create" lib app scripts
  # → lib/adapters/embeddings/openai.ts:<line>:        () => client.embeddings.create({ model, input: batch }),
  ```

  The Vercel AI SDK (`ai`, `@ai-sdk/openai`) is used for the agent loop only and is similarly isolated to `lib/app/agent/run.ts` (enforced by a repo-walking test in `lib/app/agent/run.test.ts`).

- **"Accepts file uploads (CSV and PDF)."** The UI exposes a drag-and-drop panel that posts to `POST /api/upload`; ingestion progress is streamed back via `GET /api/ingest` (Server-Sent Events). The chat input gates on the first `file-done` event.

- **"Handle CSV columns you've never seen."** `lib/domain/csv/parse.ts` resolves canonical fields (item, unit, quantity, unit price, bidder, etc.) by a synonym table plus a Jaro-Winkler tiebreaker over normalized headers. Unmapped headers are returned in `unmapped[]` so the agent can acknowledge them. A renamed-header fixture (`UNIT_PR` → `UnitPrice`) is part of the test suite.

- **"Tools the LLM can operate."** The agent exposes three structured tools with zod schemas — `query_bids`, `find_outliers`, `search_documents` — defined in `lib/app/tools/*` and wired into `streamText` in `lib/app/agent/run.ts`. The UI renders tool-call frames inline so the reviewer can see the agent's tool choice.

## Architecture decisions

Seven ADRs drove the build. They live under `.compozy/adrs/` (gitignored as planning artifacts); the salient rationales are summarized here so the submission is self-contained.

- **ADR-001 — Tool-first single-agent architecture.** One LLM agent with three structured tools (`query_bids`, `find_outliers`, `search_documents`) rather than a deterministic-CSV split or a heavy-preprocessing thin agent. Why: the brief explicitly rewards tool legibility; tools are independently testable and individually replaceable. Trade-off: misrouting shows up as a wrong answer, not a code bug — mitigated by tight tool descriptions, a system prompt with worked examples per tool, and this smoke script.

- **ADR-002 — Next.js 15 App Router as the single-repo host.** UI and Route Handlers in one TypeScript project, started with `pnpm dev`. Why: one install, one command, one origin. Trade-off: server/client coupling — managed with `import "server-only"` boundaries and a module-singleton vector store.

- **ADR-003 — SDK split (Vercel AI SDK + OpenAI SDK).** Vercel AI SDK for the agent loop and tool-call streaming (`streamText`, `useChat`); the official `openai` SDK for embeddings (literal brief compliance, verifiable in one grep). Trade-off: two SDKs, one extra dep — buys near-free streaming UI and an unambiguous compliance line.

- **ADR-004 — Hybrid PDF ingestion with WASM-only rasterization.** pdfjs-dist text-layer for textual specs; `pdf-to-png-converter` (WASM) + `gpt-4o-mini` Vision for scanned pages. Why: install path stays native-module-free, so `pnpm install` works on any Node 20+ machine. Trade-off: two code paths inside `lib/app/ingest-pdf.ts` and a per-page Vision-API call on scanned pages — bounded by a content-hashed page-image OCR cache.

- **ADR-005 — In-memory vector store with content-hashed JSON cache.** Module-level singleton (`lib/adapters/vector-store/in-memory.ts`); lazy hydration from `.cache/embeddings/<file-hash>-<model>.json`. Why: zero infra, instant restarts, comfortable working-set size (≈18 MB per spec volume with `text-embedding-3-small`). Trade-off: single-process only — out of scope for a local take-home.

- **ADR-006 — Unified content-hashed `.cache/` directory.** Both embeddings and OCR caches live under `.cache/{embeddings,ocr}/` with content-hashed filenames. One ignore rule, one cleanup command (`rm -rf .cache/`).

- **ADR-007 — Dual-path CSV.** Item descriptions are embedded into the shared vector store so `search_documents` can answer semantic CSV questions ("which items relate to drainage?") with row-level citations, while `query_bids` handles structural and numeric questions deterministically. Trade-off: two ingestion paths inside the CSV module — payoff: numeric answers are correct by construction.

Beyond the ADRs:

- **Outlier defaults** are `threshold=0.15`, `minPeers=3`, configurable per call. Aligned with FHWA / DOT guidance and the empty `ENG_EST_UNIT_PR` column in the provided data (no engineer's-estimate baseline; per-item peer-mean instead).
- **System prompt** explicitly routes structural vs anomaly vs semantic questions, names each tool with a worked example, and instructs the agent to acknowledge uncertainty rather than confabulate.
- **CSV citations** carry a 1-based `rowId`; PDF citations are `{ file, page }`. Both flow through the same `SourceRef` discriminated union.

## Trade-offs

- **Time-boxed scope.** The submission is the MVP from the PRD's Phased Rollout: file upload, ingestion progress, tool-using chat, citations. Phase 2 items (replace/swap uploads mid-session, suggested follow-ups, configurable outlier threshold in the UI) are deferred.
- **OCR variance.** Vision OCR is not deterministic across runs; the per-page-image cache pins the first-run output so subsequent reasoning is reproducible. Imperfect OCR is acceptable — the agent cites pages so the reviewer can verify against the source PDF.
- **In-memory store, single process.** No external vector DB. The cost is no multi-process state and a working set that has to fit in process memory; the payoff is `pnpm install && pnpm dev` with zero infra and instant restarts.
- **No native modules.** Everything is JS/WASM (pdfjs-dist + `pdf-to-png-converter`), trading a slower per-page raster for an install path that works on Mac-ARM, Mac-x64, Linux, and Windows without `node-gyp`.
- **`pnpm dev`, not `pnpm build && pnpm start`.** HMR is irrelevant during a reviewer demo and the cache hydrates in sub-second on each reload (ADR-002, ADR-005). `build && start` remains available for a long-running stable demo.
- **Test budget.** Pure-domain unit tests on the high-leverage code (CSV parsing including a renamed-header fixture, outlier math, tool I/O shape, vector-store round-trip), integration tests for the ingestion services and route handlers, and this manual smoke script for the four brief example questions. UI end-to-end and OCR-quality tests are explicitly out of scope.

## What I'd change with more time

- **Replace/swap previously uploaded files.** Currently additive only; replacement is Phase 2.
- **Suggested follow-up questions.** After each answer, surface 2-3 follow-ups generated from the cited rows/pages to make the agent's affordances discoverable.
- **Configurable outlier knobs in the UI.** Threshold and `minPeers` are tool inputs today; expose them in a small advanced panel.
- **Multi-project bid history.** Cross-project peer-price comparisons beyond a single CSV (Phase 3 in the PRD).
- **Plan-set image understanding.** Today the plan set goes through OCR only; multimodal embeddings on rasterized pages would catch drawings that have no text layer.
- **Stronger retrieval on the spec volumes.** ≈1000 spec pages dilute search relevance; section-aware chunking and a re-ranker pass would tighten answer quality on narrow questions.
- **Persistent named workspaces.** Today everything lives in the singleton store with `.cache/` for re-uploads; a small SQLite index would let a reviewer keep multiple bid sessions alongside each other.
- **Provider-swappable reasoning.** The agent is wired through `@ai-sdk/openai`; routing through a provider registry (`createProviderRegistry`) would let an evaluator pin Anthropic or another provider via env without code changes.
- **Telemetry surface.** Today we log structured JSON per ingestion phase and per tool call; a small dashboard summarizing token spend and cache hit rates per session would be cheap to add.

## Smoke evidence

The smoke script drives the four brief example questions through `runAgent` end-to-end against `docs/sample_bid_tabulation.csv` and `docs/plans.pdf`, asserting that each answer contains at least one `sourceRef` citation and that `find_outliers` flags at least one row from the provided CSV.

Run:

```bash
OPENAI_API_KEY=sk-... pnpm tsx scripts/smoke-spec-questions.ts
```

What it asserts:

- For each of the four questions, the agent invokes at least one tool whose result yields a `sourceRef` (either a `csv-row` rowId or a `pdf-page` `{ file, page }`).
- For the deviation-outliers question specifically, `find_outliers` is called and its `flagged[]` is non-empty.

What it costs (one-time, cached after the first run): a full CSV embedding pass, a per-page Vision OCR pass over `docs/plans.pdf`, and four agent turns with tool calls. Subsequent runs are near-instant because both caches (embeddings, OCR) are content-hashed under `.cache/`.

Latest run: not yet recorded for this submission. The submission build chain is verified locally with `pnpm typecheck && pnpm test && pnpm lint` green; the smoke script is the final manual step before submission and its output should be pasted here.

## Repository layout

```
app/                Next.js Route Handlers + UI page
  api/upload        POST — accepts CSV/PDF, returns { fileHash, cached }
  api/ingest        GET  — SSE stream of IngestEvent
  api/chat          POST — Vercel AI SDK chat stream
components/         React + shadcn primitives (chat, upload panel)
lib/
  domain/           pure rules — CSV parse, outlier math, chunking, ports
  adapters/         concrete adapters — openai client, embeddings, vector store, pdf
  app/              use cases — ingest-csv, ingest-pdf, agent/run, tools/*
  config/env.ts     zod-validated env loader
docs/               provided fixtures (CSV + PDFs) + take-home spec
scripts/            smoke-spec-questions.ts (this submission's evidence script)
tests/              integration + cross-module tests
```
