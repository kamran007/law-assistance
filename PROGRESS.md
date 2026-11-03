# Build Progress — BD-LawAssist MVP

Live status of the build. Task IDs come from [docs/implementation_plan.md](docs/implementation_plan.md), which carries the matching checkboxes.
Legend: ✅ done & verified · 🟡 code written, verification pending · ⬜ not started · ⛔ blocked

**Current sprint:** S1 (Weeks 1–2) — Foundations & Scraper
**Last updated:** 2026-11-03

---

## Sprint 1 status

| ID | Task | Status | Evidence / Notes |
| :--- | :--- | :---: | :--- |
| OPS-01 | Monorepo layout | 🟡 | pnpm workspace with `apps/api`, `packages/{config,legal-text,db}`. Still missing: `apps/worker`, `apps/web`, `packages/{contracts,providers,prompts}`, `mobile/`, `infra/`, `evals/` (created when their tasks start) |
| OPS-02 | docker-compose | 🟡 | `docker-compose.yml` written (mysql 8.4 + ngram, redis, qdrant, minio, TEI under `--profile ml`). **Not yet run: Docker Desktop was not running** |
| OPS-03 | CI pipeline | 🟡 | `.github/workflows/ci.yml` (lint, typecheck, unit, Testcontainers integration, Gitleaks, Semgrep). Not run on GitHub yet (no remote). Trivy is added when Docker images exist |
| OPS-04 | Terraform base | ⬜ | |
| OPS-05 | Zod-validated config | ✅ | `packages/config`; 5 tests; errors never echo secret values; secrets required in staging/prod |
| BE-01 | Drizzle schema (17 tables) | 🟡 | `packages/db/src/schema/*`, migrations `0000_init.sql` + `0001_fulltext_and_triggers.sql`. Type-checks. **Applying to real MySQL is pending (needs Docker)** |
| BE-02 | DB grants + citizen trigger | 🟡 | `packages/db/sql/grants.sql` (per-table, append-only `audit_log`); trigger in migration 0001. Covered by `db.int.test.ts`, not yet run |
| BE-02a | Scoped repositories + lint ban | ✅ | `packages/db/src/scoped.ts`; ESLint `no-restricted-imports` verified to fail on a deliberate violation |
| DATA-01 | bdlaws URL/HTML spike | ⬜ | **Next up** |
| DATA-02 | legal-text normalizer & hashing | ✅ | 27 tests; 95.3% statement coverage |
| DATA-03 | Crawler worker | ⬜ | |
| DATA-04 | Cheerio parser | ⬜ | |
| DATA-05 | Versioning transaction + outbox | ⬜ | |
| — | API skeleton (early part of BE-05) | ✅ | `apps/api`: Fastify + Zod, helmet, CORS, RFC 9457 errors, `/health`, `/ready`, log redaction; 5 tests |

## Verification snapshot (2026-11-03)

| Check | Result |
| :--- | :--- |
| `pnpm lint` | ✅ clean |
| `tsc` (config, legal-text, db, api) | ✅ clean |
| `pnpm test` (unit) | ✅ 37 / 37 passed |
| `pnpm test:integration` | ⛔ not run — Docker daemon not running |

## Open items & blockers

1. **Start Docker Desktop**, then run `pnpm test:integration`. This verifies BE-01, BE-02 and the tenant-isolation and versioning constraints against real MySQL 8.4.
2. **PRE-01: rotate the AI relay API key** that was pasted into chat. Store new keys only in `.env` (git-ignored) or Secrets Manager.
3. Create a GitHub remote so CI (OPS-03) can run.
4. RDS later needs `log_bin_trust_function_creators=1` so migrations can create triggers (noted in `grants.sql`).

## Decisions made during build

| Date | Decision | Why |
| :--- | :--- | :--- |
| 2026-11-03 | TypeScript pinned to 6.0 (not 7) | typescript-eslint 8.x supports TS < 6.1 |
| 2026-11-03 | Node 22+ (`engines`); dev machine runs Node 24 | TRD §2 targets 22 LTS; 24 is compatible |
| 2026-11-03 | Spec documents moved to `docs/` | Keep the repo root for code |
| 2026-11-03 | Special Unicode characters built from code points in source, never `\u` escapes | Readable and reviewable; avoids invisible characters in regex literals |
| 2026-11-03 | Bangla sub-section letters map ক→A, খ→B, … in consonant order | Matches inserted-section convention (৩২৬ক = 326A). **LEGAL to confirm beyond ঙ** |

## Next steps (in order)

1. Run the integration tests once Docker is up; fix anything they surface.
2. DATA-01: spike on bdlaws URL patterns and HTML structure (10 representative Acts).
3. DATA-03 / DATA-04 / DATA-05: crawler, parser, versioning transaction with outbox.
4. Start `apps/worker` (BullMQ) for the scraper jobs.
