# bid-agent

A question-answering assistant for construction estimators. Ingests a DOT bid-tabulation CSV plus project PDFs, then answers natural-language questions through a single tool-using LLM agent. Every answer cites the CSV row or PDF page it came from.

## Setup

Clone to working chat in under five minutes on Node 20+ with pnpm.

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

- Node `>=20`, pnpm 10 (`packageManager: pnpm@10.20.0`).
- An `OPENAI_API_KEY` with access to `text-embedding-3-small`, `gpt-4o`, and `gpt-4o-mini`.
- Provided fixtures under `docs/` ship with the repo.

`pnpm test` runs the Vitest suite; `rm -rf .cache/ tmp/` is the single recovery step if anything looks stale.

## Architecture decisions

Seven ADRs drove the build. They live under `.compozy/adrs/` (not versioned); the salient rationales are summarized here.

- **ADR-001 — Tool-first single-agent architecture.** One LLM agent with three structured tools (`query_bids`, `find_outliers`, `search_documents`) rather than a deterministic-CSV split or a heavy-preprocessing thin agent. Why: tool legibility matters — tools are independently testable and individually replaceable. Trade-off: misrouting shows up as a wrong answer, not a code bug — mitigated by tight tool descriptions, a system prompt with worked examples per tool, and the smoke script below.

- **ADR-002 — Next.js 15 App Router as the single-repo host.** UI and Route Handlers in one TypeScript project, started with `pnpm dev`. Why: one install, one command, one origin. Trade-off: server/client coupling — managed with `import "server-only"` boundaries and a module-singleton vector store.

- **ADR-003 — SDK split (Vercel AI SDK + OpenAI SDK).** Vercel AI SDK for the agent loop and tool-call streaming (`streamText`, `useChat`); the official `openai` SDK for embeddings. Trade-off: two SDKs, one extra dep — buys near-free streaming UI and a single, grep-verifiable embeddings call site.

- **ADR-004 — Hybrid PDF ingestion with WASM-only rasterization.** pdfjs-dist text-layer for textual specs; `pdf-to-png-converter` (WASM) + `gpt-4o-mini` Vision for scanned pages. Why: install path stays native-module-free, so `pnpm install` works on any Node 20+ machine. Trade-off: two code paths inside `lib/app/ingest-pdf.ts` and a per-page Vision-API call on scanned pages — bounded by a content-hashed page-image OCR cache.

- **ADR-005 — In-memory vector store with content-hashed JSON cache.** Module-level singleton (`lib/adapters/vector-store/in-memory.ts`); lazy hydration from `.cache/embeddings/<file-hash>-<model>.json`. Why: zero infra, instant restarts, comfortable working-set size (≈18 MB per spec volume with `text-embedding-3-small`). Trade-off: single-process only — acceptable for a local single-user workload.

- **ADR-006 — Unified content-hashed `.cache/` directory.** Both embeddings and OCR caches live under `.cache/{embeddings,ocr}/` with content-hashed filenames. One ignore rule, one cleanup command (`rm -rf .cache/`).

- **ADR-007 — Dual-path CSV.** Item descriptions are embedded into the shared vector store so `search_documents` can answer semantic CSV questions ("which items relate to drainage?") with row-level citations, while `query_bids` handles structural and numeric questions deterministically. Trade-off: two ingestion paths inside the CSV module — payoff: numeric answers are correct by construction.

Outlier defaults are `threshold=0.15`, `minPeers=3` (configurable per call), aligned with FHWA / DOT guidance and the empty `ENG_EST_UNIT_PR` column in the provided data.

## Roadmap

- **Replace/swap previously uploaded files.** Currently additive only.
- **Suggested follow-up questions** generated from cited rows/pages to make the agent's affordances discoverable.
- **Plan-set image understanding.** Multimodal embeddings on rasterized pages to catch drawings that have no text layer.
- **Persistent named workspaces.** A small SQLite index would allow multiple bid sessions alongside each other.
- **Provider-swappable reasoning.** Route through a provider registry so an evaluator can pin Anthropic or another provider via env without code changes.

## Smoke test

```bash
OPENAI_API_KEY=sk-... pnpm tsx scripts/smoke-spec-questions.ts
```

Asserts each of four canonical questions invokes at least one tool that yields a `sourceRef`, and that `find_outliers` flags ≥1 row. Last run (2026-05-17, both fixtures cached, gpt-4o): all four passed. Subsequent runs are near-instant because embeddings and OCR caches are content-hashed under `.cache/`.

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
docs/               provided fixtures (CSV + PDFs)
scripts/            smoke-spec-questions.ts (end-to-end smoke)
tests/              integration + cross-module tests
```
