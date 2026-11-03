# Build Progress — BD-LawAssist MVP

Live status of the build. Task IDs come from [docs/implementation_plan.md](docs/implementation_plan.md), which carries the matching checkboxes.
Legend: ✅ done & verified · 🟡 code written, verification pending · ⬜ not started · ⛔ blocked

**Current sprint:** S2 (Weeks 3–4) — Corpus Live, Auth & Retrieval Core. S1 code is merged; S1 leftovers: DATA-01 live check, BE-02 grants test, OPS-02
**Last updated:** 2026-11-03

---

## Sprint 1 status

| ID | Task | Status | Evidence / Notes |
| :--- | :--- | :---: | :--- |
| OPS-01 | Monorepo layout | 🟡 | pnpm workspace with `apps/{api,worker}`, `packages/{config,legal-text,db}`. Still missing: `apps/web`, `packages/{contracts,providers,prompts}`, `mobile/`, `infra/`, `evals/` (created when their tasks start) |
| OPS-02 | docker-compose | 🟡 | `docker-compose.yml` written (mysql 8.4 + ngram, redis, qdrant, minio, TEI under `--profile ml`). **Not yet run: Docker Desktop was not running** |
| OPS-03 | CI pipeline | 🟡 | `.github/workflows/ci.yml` (lint, typecheck, unit, Testcontainers integration, Gitleaks, Semgrep). Remote `origin` = github.com/kamran007/law-assistance. Run on `main` @ `c8d5f1f`: `check` job all green incl. integration; `security` job red, because Semgrep found 2 warnings that PRs (diff-only scan) didn't show. Fixed on `fix/semgrep-findings` (local Semgrep 1.183, same rulesets: 0 findings). Done when a PR shows green in < 10 min. Trivy is added when Docker images exist |
| OPS-04 | Terraform base | ⬜ | |
| OPS-05 | Zod-validated config | ✅ | `packages/config`; 5 tests; errors never echo secret values; secrets required in staging/prod |
| BE-01 | Drizzle schema (17 tables) | ✅ | `packages/db/src/schema/*`, migrations `0000_init.sql` + `0001_fulltext_and_triggers.sql`. **Verified on CI (`main` @ `c8d5f1f`):** migrations apply cleanly to empty MySQL 8.4; `db.int.test.ts` 9/9 (one-current-version index, ngram FULLTEXT, tenant isolation, optimistic concurrency) |
| BE-02 | DB grants + citizen trigger | 🟡 | Trigger ✅ verified on CI (citizen case conversation → errno 1644 `CASE_CONVERSATION_ROLE_FORBIDDEN`; second conversation per case → 1062). `packages/db/sql/grants.sql` (per-table, append-only `audit_log`) is **not yet tested**: needs a test that applies it and checks each DB user's privileges |
| BE-02a | Scoped repositories + lint ban | ✅ | `packages/db/src/scoped.ts`; ESLint `no-restricted-imports` verified to fail on a deliberate violation |
| DATA-01 | bdlaws URL/HTML spike | ⛔ | URL patterns + selectors written as config (`apps/worker/src/scrape/source-config.ts`), doc in `apps/worker/src/scrape/README.md`. **Live check blocked:** robots.txt answered once (`Allow: /`), then every page request timed out or was reset. Selectors are unverified assumptions |
| DATA-02 | legal-text normalizer & hashing | ✅ | 27 tests; 95.3% statement coverage |
| DATA-03 | Crawler worker | 🟡 | `apps/worker`: undici client, global 1 req/s limiter, robots.txt (refuses to crawl if unreachable), ETag/Last-Modified in Redis, backoff 2s→60s + jitter + Retry-After, gzip snapshots to S3 (`raw/bdlaws/{id}/{ts}.html.gz`), BullMQ schedulers (nightly 02:00, weekly full Fri 03:00 Asia/Dhaka), CLI. 11 unit tests with a fake fetch. Not yet run against the portal, MinIO or Redis |
| DATA-04 | Cheerio parser | 🟡 | `parser.ts` (Act → Chapter → Section → Sub-section/Proviso/Explanation/Illustration → Footnotes) + `legal-text/footnote.ts` (action, amending Act, "with effect from" date, Bangla and English). Markers stripped for hashing only. 13 parser tests + 21 footnote/date tests on EN/BN fixtures. **Fixtures are hand-made; must be re-checked against real snapshots (DATA-01)** |
| DATA-05 | Versioning transaction + outbox | ✅ | `versioning.ts`: read-only plan, then 20% safety valve (quarantine, nothing written), then one REPEATABLE READ tx per section with `FOR UPDATE` + outbox (CREATED / CLOSED / NOTIFY_AFFECTED_CASES / STATUTE_STATUS_CHANGED), retry on dup-key/deadlock. **Verified on GitHub Actions 2026-11-03:** `versioning.int.test.ts` 10/10 passed against MySQL 8.4 (amend → archive → new current, 4 concurrent workers, concurrent first ingest, safety valve, removal, repeal, Sprint 1 demo via `runScrape`). Plan logic: 10 unit tests |
| — | API skeleton (early part of BE-05) | ✅ | `apps/api`: Fastify + Zod, helmet, CORS, RFC 9457 errors, `/health`, `/ready`, log redaction; 5 tests |

## Sprint 2 status

| ID | Task | Status | Evidence / Notes |
| :--- | :--- | :---: | :--- |
| DATA-06 | Chunker + outbox worker → TEI → Qdrant | 🟡 | Branch `feature/data-embedding`. `apps/worker/src/index/{chunker,indexer,outbox}.ts` + `packages/providers` (TEI client, Qdrant chunk index). Chunks: 350–500 est. tokens, split on sub-section/proviso/explanation, Act/section heading prefixed. Deterministic chunk ids (UUID v8 of section_id + index). All writes re-read MySQL, so replays converge. Unchanged chunks get a payload-only refresh, no re-embed. Failures: attempts + `last_error` (no text), parked after 10. Outbox drained every 15 s (BullMQ, concurrency 1). 18 unit tests (chunker, TEI client, filters). `index.int.test.ts` (MySQL + Qdrant 1.15: index, **replay idempotent**, point-in-time filters incl. `valid_to` boundary, repeal propagation, failure/retry) **written, not run yet: first run on the PR's CI** |
| DATA-07 | Qdrant collection setup + `reindex --all` | 🟡 | `collection.ts`: alias `section_chunks` → physical `section_chunks_<ts>`, 1024-dim cosine, HNSW m=16/ef_construct=128, payload indexes (is_current, valid_from/to datetime, statute_id, section_id, act_status). `reindexAll` rebuilds all versions from MySQL, catches up on sections changed during the rebuild, swaps the alias, drops the old collection. CLI: `--setup-index`, `--reindex-all`, `--drain-outbox`. Covered by `index.int.test.ts` (not run yet) |
| DATA-08 | Ingest top 50 Acts | ⛔ | Needs DATA-01 (portal reachable) and TEI running (`docker compose --profile ml`) |
| DATA-10 | Nightly job + weekly full re-crawl + dashboard data | 🟡 | Schedulers exist since S1 (`main.ts`). `scrape_runs`/`scrape_events` are written. Dashboard query/API not started (belongs with the admin API) |

## Verification snapshot (2026-11-03)

| Check | Result |
| :--- | :--- |
| `pnpm lint` | ✅ clean |
| `pnpm typecheck` (config, legal-text, db, api, worker) | ✅ clean |
| `pnpm test` (unit) | ✅ 92 / 92 passed (7 files) |
| Coverage: `legal-text` / worker HTTP + parser | 98% / 96% + 94% statements. `versioning.ts` + `run-scrape.ts` are covered only by the integration test |
| `pnpm test:integration` (CI, `main` @ `c8d5f1f`) | ✅ db 9/9, worker 10/10 against MySQL 8.4 (Testcontainers) |
| Semgrep (p/typescript, p/nodejsscan, p/secrets) | ✅ 0 findings locally after `fix/semgrep-findings`. Was 2 warnings: regex on parser input (tightened, linear-time, annotated) and `Math.random` retry jitter (now `crypto.randomInt`) |
| Worker CLI smoke test | ✅ config + wiring load. Fails at the first DB query, as expected with no MySQL |

## Open items & blockers

1. **Start Docker Desktop** for local integration runs and OPS-02 (`docker compose up`). CI already runs the integration tests.
2. **bdlaws unreachable from the dev network** (DATA-01). Try another network or a VPN egress in BD. Without it, the parser selectors stay unverified.
3. **PRE-01: rotate the AI relay API key** that was pasted into chat. Store new keys only in `.env` (git-ignored) or Secrets Manager.
4. `main` CI fully green since PR #3 (`46856b0`).
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
| 2026-11-03 | DB-constraint tests assert on the driver error (`err.cause`: errno + message), not on Drizzle's wrapper message | Drizzle 0.45 wraps driver errors in `DrizzleQueryError`; errno is also stricter than message matching |
| 2026-11-03 | Semgrep warnings get fixed, not suppressed, where cheap. A `nosemgrep` needs a rule id and a reason in the comment | Keeps the full-repo scan on `main` meaningful |
| 2026-11-03 | New `packages/providers` (TRD §3.2): `EmbeddingProvider` (TEI) + `ChunkIndex` (Qdrant) with point-in-time filters built in | Business logic stays vendor-neutral; BE-07 retrieval reuses the same filter builder |
| 2026-11-03 | Qdrant client pinned to **1.15.1** (exact) to match the `qdrant/qdrant:v1.15.4` server | The client warns or fails beyond one minor version of skew; bump both together |
| 2026-11-03 | Chunk ids are deterministic (UUID v8 from `section_id` + index); chunk rows are replaced per section in one tx | Same Qdrant point ids on every replay or reindex → idempotent by construction |
| 2026-11-03 | Outbox handlers ignore event payloads and re-read MySQL | Replays, duplicates and reordering converge on the source of truth (TRD §4.4) |
| 2026-11-03 | Point-in-time filter is `valid_from ≤ d < valid_to` (`valid_to` exclusive) | The amendment date belongs to the new version; matches the versioning transaction |
| 2026-11-03 | Token counts are a heuristic (EN 1.3/word, BN 2.2/word, digits/punct 1), not a real tokenizer | No JS tokenizer for bge-m3. Size only affects granularity; TEI truncates over-long input, so no text is lost |
| 2026-11-03 | Outbox consumer handles only index events. `NOTIFY_AFFECTED_CASES` stays unprocessed for the future notification consumer | One `processed_at` column per event; separate consumers by event type |
| 2026-11-03 | `msgpackr-extract` native build disabled (`allowBuilds: false`) | Optional BullMQ speed-up; pure-JS fallback is fine |
| 2026-11-03 | Bangla sub-section letters map ক→A, খ→B, … in consonant order | Matches inserted-section convention (৩২৬ক = 326A). **LEGAL to confirm beyond ঙ** |

## Next steps (in order)

1. Open the PR for `feature/data-embedding` and check its CI (first run of `index.int.test.ts`); merge when green. Closes DATA-06/07 and OPS-03 (green PR pipeline).
1a. Add a grants test to close BE-02.
2. DATA-01: from a network that reaches bdlaws, save the 10 spike Acts as fixtures, then correct selectors and URL patterns (checklist in `apps/worker/src/scrape/README.md`).
3. Run the Sprint 1 demo for real: `docker compose up -d` → `pnpm db:migrate` → `pnpm --filter @lawassist/worker scrape -- --acts <10 ids>` twice → edit a snapshot → `--act <id> --snapshot <key>`.
4. Then Sprint 2: DATA-06 chunker + outbox worker → TEI → Qdrant.
