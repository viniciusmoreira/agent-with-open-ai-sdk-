# AGENTS.md

Operational guide for any agent (human or LLM) contributing to this project. Keep it short: rules of thumb only; rationale lives in the README.

## Context

Next.js 15 (App Router, TypeScript) that ingests a DOT bid-tabulation CSV plus project PDFs, generates embeddings via the OpenAI SDK, and answers questions through a tool-using agent (Vercel AI SDK). The README documents setup, key architectural decisions, and trade-offs — read it before changing architecture.

## Design principles

- **SOLID** drives every module:
  - SRP: one file, one reason to change (e.g., `lib/csv/parse.ts` only parses; embedding lives in `lib/embeddings/`).
  - OCP: new bid operations enter as a new `operation` in the `query_bids` schema, without touching callers.
  - LSP: tool return types honor the contracts in `lib/agent/tools.ts`.
  - ISP: zod tool schemas expose only what each operation needs.
  - DIP: the domain depends on ports (interfaces), never on concrete SDKs.
- **Hexagonal architecture (ports & adapters):**
  - **Domain** (`lib/domain/`): pure rules — outlier math, header mapping, chunking. Zero I/O, zero SDK.
  - **Ports** (`lib/domain/ports/`): interfaces — `EmbeddingsPort`, `VectorStorePort`, `OcrPort`, `PdfTextPort`.
  - **Adapters** (`lib/adapters/`): concrete implementations — `openai-embeddings.ts`, `in-memory-vector-store.ts`, `vision-ocr.ts`, `pdfjs-text.ts`.
  - **Application** (`lib/app/`): use cases that orchestrate ports — `ingest-csv`, `ingest-pdf`, `answer-question`.
  - **Driving adapters** (`app/api/*`): Route Handlers translate HTTP ↔ use cases.
  - Rule of thumb: the domain never imports `openai`, `ai`, `next`, or `fs`. If it needs to, route it through a port.

## Security (OWASP Top 10)

Check before every PR. Minimum required mitigations:

- **A01 Broken Access Control** — the app is single-user local; even so, Route Handlers only serve data from the current session. Never expose absolute FS paths to the client.
- **A02 Cryptographic Failures** — `OPENAI_API_KEY` lives server-side only; never in client code, never in URLs, never logged. Read `process.env` only from Server Components and Route Handlers.
- **A03 Injection** — every tool input goes through zod with `.strict()`. No string concatenation in filters. Uploads validated by magic bytes, not just extension.
- **A04 Insecure Design** — explicit limits: max upload size, OCR timeout, max chunks per request. Defaults documented.
- **A05 Security Misconfiguration** — no `NEXT_PUBLIC_*` for secrets. Default Next headers retained; strict CSP when serving dynamic HTML.
- **A06 Vulnerable Components** — `pnpm audit` clean before submission. No unused dependencies.
- **A07 Identification & Authentication** — out of scope (local). Do not introduce fake login flows.
- **A08 Software & Data Integrity** — `pnpm-lock.yaml` committed. No `curl | sh` in scripts.
- **A09 Logging & Monitoring** — structured logs (JSON), without PII, without API keys, without full prompt bodies if they may contain sensitive upload content.
- **A10 SSRF** — outbound calls only to `api.openai.com`. Never fetch a URL provided by the user.

## Secrets and configuration

- **Never commit secrets.** Everything via `.env.local` (git-ignored).
- **`.env.example` is the source of truth for env shape**, with empty values or descriptive placeholders (never functional). Never paste a real token, even a "revoked" one.
- Sensitive variables never prefixed with `NEXT_PUBLIC_` so they cannot leak into the client bundle.
- Access env through a typed wrapper (`lib/config/env.ts`) that validates with zod at boot — fail fast if a key is missing.

### Minimal `.env.example`

```
OPENAI_API_KEY=
EMBEDDING_MODEL=text-embedding-3-small
REASONING_MODEL=gpt-4o
```

No sensitive defaults, no internal URLs, no real values.

## Code conventions

- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`).
- No implicit `any`; use `unknown` + narrow when needed.
- Pure functions in the domain; side effects at the edges.
- Domain errors are discriminated union types, not thrown strings.
- Comment only when the "why" is not obvious.

## Tests (fixed take-home scope)

- Vitest on the pure domain: header mapper (with a renamed-column fixture), outlier math, tool I/O shape, vector-store round-trip.
- End-to-end smoke script covering the four brief example questions.
- External adapters mocked via `vi.mock`. Zero real OpenAI calls in CI.

## Change workflow

1. If the change alters a port contract, update the interface before the adapter.
2. Test the domain before touching adapters.
3. `pnpm typecheck && pnpm test && pnpm lint` green before committing.
4. Document any new architectural decision in the README.

## Out of scope

UI polish, authentication, deployment, session persistence, multi-tenant, external database.
