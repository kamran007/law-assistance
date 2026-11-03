# Build Progress — BD-LawAssist MVP

Live status of the build. Task IDs come from [docs/implementation_plan.md](docs/implementation_plan.md), which carries the matching checkboxes.
Legend: ✅ done & verified · 🟡 code written, verification pending · ⬜ not started · ⛔ blocked

**Current sprint:** S1 (Weeks 1–2) — Foundations & Scraper
**Last updated:** 2026-11-03

---

## Sprint 1 status

| ID | Task | Status | Evidence / Notes |
| :--- | :--- | :---: | :--- |
| OPS-01 | Monorepo layout | 🟡 | pnpm workspace with `apps/{api,worker}`, `packages/{config,legal-text,db}`. Still missing: `apps/web`, `packages/{contracts,providers,prompts}`, `mobile/`, `infra/`, `evals/` (created when their tasks start) |
| OPS-02 | docker-compose | 🟡 | `docker-compose.yml` written (mysql 8.4 + ngram, redis, qdrant, minio, TEI under `--profile ml`). **Not yet run: Docker Desktop was not running** |
| OPS-03 | CI pipeline | 🟡 | `.github/workflows/ci.yml` (lint, typecheck, unit, Testcontainers integration, Gitleaks, Semgrep). Remote `origin` = github.com/kamran007/law-assistance (2026-11-03). First CI run comes with the `feature/data-scraper` PR; result pending. Trivy is added when Docker images exist |
| OPS-04 | Terraform base | ⬜ | |
| OPS-05 | Zod-validated config | ✅ | `packages/config`; 5 tests; errors never echo secret values; secrets required in staging/prod |
| BE-01 | Drizzle schema (17 tables) | 🟡 | `packages/db/src/schema/*`, migrations `0000_init.sql` + `0001_fulltext_and_triggers.sql`. Type-checks. **Applying to real MySQL is pending (needs Docker)** |
| BE-02 | DB grants + citizen trigger | 🟡 | `packages/db/sql/grants.sql` (per-table, append-only `audit_log`); trigger in migration 0001. Covered by `db.int.test.ts`, not yet run |
| BE-02a | Scoped repositories + lint ban | ✅ | `packages/db/src/scoped.ts`; ESLint `no-restricted-imports` verified to fail on a deliberate violation |
| DATA-01 | bdlaws URL/HTML spike | ⛔ | URL patterns + selectors written as config (`apps/worker/src/scrape/source-config.ts`), doc in `apps/worker/src/scrape/README.md`. **Live check blocked:** robots.txt answered once (`Allow: /`), then every page request timed out or was reset. Selectors are unverified assumptions |
| DATA-02 | legal-text normalizer & hashing | ✅ | 27 tests; 95.3% statement coverage |
| DATA-03 | Crawler worker | 🟡 | `apps/worker`: undici client, global 1 req/s limiter, robots.txt (refuses to crawl if unreachable), ETag/Last-Modified in Redis, backoff 2s→60s + jitter + Retry-After, gzip snapshots to S3 (`raw/bdlaws/{id}/{ts}.html.gz`), BullMQ schedulers (nightly 02:00, weekly full Fri 03:00 Asia/Dhaka), CLI. 11 unit tests with a fake fetch. Not yet run against the portal, MinIO or Redis |
| DATA-04 | Cheerio parser | 🟡 | `parser.ts` (Act → Chapter → Section → Sub-section/Proviso/Explanation/Illustration → Footnotes) + `legal-text/footnote.ts` (action, amending Act, "with effect from" date, Bangla and English). Markers stripped for hashing only. 13 parser tests + 21 footnote/date tests on EN/BN fixtures. **Fixtures are hand-made; must be re-checked against real snapshots (DATA-01)** |
| DATA-05 | Versioning transaction + outbox | 🟡 | `versioning.ts`: read-only plan, then 20% safety valve (quarantine, nothing written), then one REPEATABLE READ tx per section with `FOR UPDATE` + outbox (CREATED / CLOSED / NOTIFY_AFFECTED_CASES / STATUTE_STATUS_CHANGED), retry on dup-key/deadlock. Removed sections get superseded. A repealed empty page changes status only. Plan logic unit-tested (10 tests). `versioning.int.test.ts` (amend → archive → new current, 4 concurrent workers, concurrent first ingest, valve, removal, repeal, Sprint 1 demo via `runScrape`) **written, not run: needs Docker** |
| — | API skeleton (early part of BE-05) | ✅ | `apps/api`: Fastify + Zod, helmet, CORS, RFC 9457 errors, `/health`, `/ready`, log redaction; 5 tests |

## Verification snapshot (2026-11-03)

| Check | Result |
| :--- | :--- |
| `pnpm lint` | ✅ clean |
| `pnpm typecheck` (config, legal-text, db, api, worker) | ✅ clean |
| `pnpm test` (unit) | ✅ 92 / 92 passed (7 files) |
| Coverage: `legal-text` / worker HTTP + parser | 98% / 96% + 94% statements. `versioning.ts` + `run-scrape.ts` are covered only by the integration test |
| `pnpm test:integration` | ⛔ not run: Docker daemon not running (now includes `apps/worker/test/versioning.int.test.ts`) |
| Worker CLI smoke test | ✅ config + wiring load. Fails at the first DB query, as expected with no MySQL |

## Open items & blockers

1. **Start Docker Desktop**, then run `pnpm test:integration`. This verifies BE-01, BE-02, DATA-05 and the tenant-isolation and versioning constraints against real MySQL 8.4.
2. **bdlaws unreachable from the dev network** (DATA-01). Try another network or a VPN egress in BD. Without it, the parser selectors stay unverified.
3. **PRE-01: rotate the AI relay API key** that was pasted into chat. Store new keys only in `.env` (git-ignored) or Secrets Manager.
4. Open the PR for `feature/data-scraper` and check the first CI run (OPS-03). Integration tests on CI also cover DATA-05, since GitHub runners have Docker.
5. RDS later needs `log_bin_trust_function_creators=1` so migrations can create triggers (noted in `grants.sql`).

## Decisions made during build

| Date | Decision | Why |
| :--- | :--- | :--- |
| 2026-11-03 | TypeScript pinned to 6.0 (not 7) | typescript-eslint 8.x supports TS < 6.1 |
| 2026-11-03 | Node 22+ (`engines`); dev machine runs Node 24 | TRD §2 targets 22 LTS; 24 is compatible |
| 2026-11-03 | Spec documents moved to `docs/` | Keep the repo root for code |
| 2026-11-03 | Special Unicode characters built from code points in source, never `\u` escapes | Readable and reviewable; avoids invisible characters in regex literals |
| 2026-11-03 | Scraper code lives in `apps/worker/src/scrape` (no separate package). Footnote/date rules go in `packages/legal-text` | Parser needs cheerio (worker-only). Footnote rules are pure text, reusable by the API |
| 2026-11-03 | Footnote markers (`<sup>`) stripped before hashing in the parser, not in `normalizeForHash` | Keeps `HASH_NORMALIZATION_VERSION` stable; footnote renumbering doesn't create versions |
| 2026-11-03 | A version change = content hash **or** footnotes hash differs. `footnoteOnly` goes in the outbox payload, not a DB column | TRD §6.2 wants footnote-only versions tagged. Avoids a schema change; add a column later if search needs it |
| 2026-11-03 | Effective date = latest dated footnote that is *new* in this version, clamped to ≥ the previous `valid_from`. Otherwise sync date (`DETECTED_ON_SYNC`) | Only "with effect from" dates count. An amending Act's enactment date is not its commencement date |
| 2026-11-03 | v1 `valid_from`: insertion footnote date > enactment date (first ingest) > sync date | An inserted section (e.g. 326A) didn't exist at enactment |
| 2026-11-03 | Safety valve ratio = (new + changed + removed) / existing current sections; first ingest never quarantined; `--force` overrides | Layout changes usually show up as mass removals, not only edits |
| 2026-11-03 | Crawler refuses to run when robots.txt is unreachable (4xx = allow all). Run aborts after 5 consecutive network failures | Don't crawl without knowing the rules; don't log 1,480 identical failures |
| 2026-11-03 | `msgpackr-extract` native build disabled (`allowBuilds: false`) | Optional BullMQ speed-up; pure-JS fallback is fine |
| 2026-11-03 | Bangla sub-section letters map ক→A, খ→B, … in consonant order | Matches inserted-section convention (৩২৬ক = 326A). **LEGAL to confirm beyond ঙ** |

## Next steps (in order)

1. Start Docker and run `pnpm test:integration` (db + worker); fix anything it surfaces. This closes BE-01, BE-02 and DATA-05.
2. DATA-01: from a network that reaches bdlaws, save the 10 spike Acts as fixtures, then correct selectors and URL patterns (checklist in `apps/worker/src/scrape/README.md`).
3. Run the Sprint 1 demo for real: `docker compose up -d` → `pnpm db:migrate` → `pnpm --filter @lawassist/worker scrape -- --acts <10 ids>` twice → edit a snapshot → `--act <id> --snapshot <key>`.
4. Then Sprint 2: DATA-06 chunker + outbox worker → TEI → Qdrant.
