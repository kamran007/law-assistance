# BD-LawAssist — working notes for Claude

AI legal research platform for Bangladesh law (citizens, lawyers, judges). MVP is being built sprint by sprint.

## Start of every session
1. Read `PROGRESS.md`: current sprint, task status, blockers, next steps.
2. Specs are in `docs/`: SRS, `app_flow.md`, `technical_requirements_document.md` (TRD v1.1), `implementation_plan.md` (task IDs).
3. Continue from "Next steps" in `PROGRESS.md` unless the user says otherwise.

## Tracking progress (required)
- After finishing or changing a task, update **both** the task row in `PROGRESS.md` and the checkbox in `docs/implementation_plan.md`:
  `[x]` = done & verified · `[~]` = written, verification pending · `[ ]` = not started.
- Mark a task done only with evidence (tests passing, command output). Record what was verified.
- Log notable decisions in the PROGRESS.md decisions table.

## Git workflow
- `main` is always green (lint, typecheck, unit tests pass). Never commit straight to it.
- One branch per feature/task group: `feature/<area>` (e.g. `feature/data-scraper`, `feature/auth`); `fix/<topic>` for fixes.
- Conventional commits with the task IDs: `feat(scraper): … (DATA-03)`, `fix(db): …`, `chore: …`.
- Commit `PROGRESS.md` and `docs/implementation_plan.md` updates together with the code they describe.
- Merge to `main` only after verification. Note anything unverified (e.g. integration tests) in the commit message.

## Stack (fixed decisions)
Node.js 22+ / TypeScript 6 · Fastify 5 + Zod 4 · MySQL 8.4 (Drizzle ORM) · Qdrant · Redis/BullMQ · Next.js 15 · Flutter ·
AI: Anthropic via `@ai-sdk/anthropic` with `ANTHROPIC_BASE_URL` (relay) and `ANTHROPIC_API_KEY` from env only.

## Commands
- `pnpm install` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (unit + web jsdom) · `pnpm test:integration` (needs Docker)
- `docker compose up -d` (add `--profile ml` for the TEI embedding/reranker containers; `docker compose --profile worker up -d --build worker` runs the background worker with qpdf/Poppler)
- `pnpm db:generate` (after schema changes) · `pnpm db:migrate`
- `pnpm openapi` after changing API route schemas (regenerates `packages/contracts`; a test fails on drift)
- `pnpm dev:web` (Next.js on :3001) · `pnpm --filter @lawassist/web build` (while `dev:web` runs, build with `NEXT_DIST_DIR=.next-verify` so the two don't share `.next`)
- `pnpm --filter @lawassist/api s3:cors` once after `docker compose up` (lets the browser upload to the local bucket)

## Rules that must not be broken
- **Tenant isolation:** tenant tables (case_files, case_artifacts, artifact_revisions, conversations, messages) are only accessed via `scoped(db, userId)` from `@lawassist/db`. Never import `@lawassist/db/schema` in apps (ESLint blocks it). Another user's resource → 404.
- **Conversations:** Citizens have general conversations only. Lawyers/Judges get exactly one conversation per case, created with the case. DB trigger + service layer both enforce this.
- **No AI-generated bail/cognizable/compoundable status:** this comes only from `crpc_schedule_metadata`.
- **Every statutory claim is cited** and validated server-side against `statute_sections`.
- **Secrets:** never write API keys or passwords into code, docs, tests or commits. Use `.env` (git-ignored) or Secrets Manager.
- Don't log document text, transcripts or user queries.
- Write special Unicode characters via `String.fromCodePoint(...)`, not `\u` escapes (the editing tool mangles them).
- The section-hash normalization (`packages/legal-text/src/normalize.ts`) must stay stable; bump `HASH_NORMALIZATION_VERSION` if it changes.

## Layout
```
apps/api          Fastify API
apps/web          Next.js 15 web app (App Router, next-intl bn/en, Tailwind v4)
apps/worker       BullMQ worker: scraper (src/scrape, see README there), vector indexing (src/index),
                  scan pipeline (src/scan; needs qpdf + Poppler, see apps/worker/Dockerfile),
                  analysis stages 3–5 (src/analysis: LLM FIR extraction, dates, sections, Schedule II),
                  SCOB case-law harvester (src/scob, see README there)
packages/config   Zod env loader
packages/contracts  Generated OpenAPI spec + types, typed API client, SSE reader (do not edit schema.ts / openapi.json)
packages/providers  TEI embedding client, Qdrant chunk index, LLM client (src/llm.ts), queue names,
                  status events (src/artifact-events.ts), FCM push (src/fcm.ts)
packages/db       Drizzle schema, migrations, scoped repos, grants.sql
packages/legal-text  Bangla/English normalization, section keys, hashing
docs/             Specs and implementation plan
```
