# Implementation Plan
## Project: BD-LawAssist — MVP (12 Weeks)

| Attribute | Details |
| :--- | :--- |
| **Inputs** | `bd_lawassist_mvp_software_requirements_specification.md` (SRS) · `app_flow.md` (App Flow) · `technical_requirements_document.md` (TRD v1.2) |
| **Stack** | Node.js 22 + Fastify · MySQL 8.4 · Qdrant · Redis/BullMQ · Next.js 15 · Flutter 3 · Anthropic via `@ai-sdk/anthropic` (custom `baseURL`) |
| **Duration** | 12 weeks, in 6 two-week sprints (S1–S6) |
| **Status** | Draft v1.1 — 2026-11-04 (adds Module D: Supreme Court judgments, tasks `JUD-*`) |

> **How to use this file.** `[x]` = done & verified · `[~]` = code written, verification pending · `[ ]` = not started. Live status is in `PROGRESS.md` at the repo root. Each task has an ID (e.g. `BE-07`), an owner role, its dependencies and a "done when" check. Tick tasks off (`[x]`) as they ship. Section numbers like "TRD §6.3" point to the spec that defines the details.

---

## 1. Team & Owners

Assumed team (adjust to actual staffing):

| Code | Role | Count | Main Areas |
| :--- | :--- | :---: | :--- |
| **BE** | Backend engineer (Node.js) | 2 | API, DB, RAG, scan pipeline, voice |
| **DATA** | Data / ML engineer | 1 | Scraper, versioning, embeddings, Qdrant, evals, glossary, SCOB judgment harvester (with BE support) |
| **WEB** | Frontend engineer (Next.js) | 1 | Web app |
| **MOB** | Mobile engineer (Flutter) | 1 | Mobile app (ramps up from S3) |
| **OPS** | DevOps (part-time) | 0.5 | AWS, Terraform, CI/CD, observability |
| **QA** | QA engineer | 1 (from S2) | Test plans, E2E, load tests, eval runs |
| **LEGAL** | Legal SME (practicing lawyer) | 1 part-time | Schedule II verification, golden Q&A set, prompt review, pilot |
| **PL** | Project lead | 1 | Scope, decisions, vendor contracts, pilot |

---

## 2. Milestones

| # | Milestone | Week | Exit Criteria |
| :--- | :--- | :---: | :--- |
| **M0** | Kickoff & foundations ready | 1 | Repo, CI, local docker-compose, dev AWS account live |
| **M1** | Law corpus live (top 50 Acts) | 3 | Nightly sync green 5 days in a row · point-in-time eval 100% · Schedule II 100% lawyer-verified |
| **M2** | Web assistant beta (internal) | 6 | Login → ask → cited answer → verifier works on staging · Q&A eval pass bar met · first token ≤ 1.5 s p90 · all SCOB issues ingested and indexed (JUD-06), judgment-metadata eval passed |
| **M3** | Scan + voice + case law feature-complete (web) | 9 | FIR scan, dictation, export, case-law search and judgment citations working on staging · FIR/OCR/STT and case-law eval bars met · 6 s / 800 ms SLAs |
| **M4** | Pilot go-live | 12 | Mobile apps in TestFlight / Play internal · full corpus ingested · load tests pass · no open high-severity security findings |

```text
Week:     1    2    3    4    5    6    7    8    9    10   11   12
Sprint:   |--S1---|--S2---|--S3---|--S4---|--S5---|--S6---|
          M0        M1             M2             M3             M4
Corpus    ██████████████                               ████████ (full 1,480)
Case law                      ██████████████ (SCOB)
API/RAG        ██████████████████
Web                 ███████████████████████████
Scan/Voice                         ██████████████████
Mobile                        ░░░░ ███████████████████████████
Evals          ████ ███████████████████████████████████████████
```

---

## 3. Pre-Work & Non-Engineering Dependencies

These items block engineering milestones. Start them in **Week 1**.

| ID | Task | Owner | Needed By | Blocks |
| :--- | :--- | :--- | :---: | :--- |
| **PRE-01** | **Rotate the AI relay API key** that was shared in plain text; store new per-environment keys in AWS Secrets Manager | PL / OPS | Week 1 | All LLM work |
| **PRE-02** | Relay due diligence: DPA, no-training and no-retention terms, security questionnaire for the `ANTHROPIC_BASE_URL` operator (TRD D10). In parallel, open a direct Anthropic API account as the fallback | PL | Week 6 | Production use of real data |
| **PRE-03** | Legal review of Bangladesh data-protection and hosting obligations (TRD §12.5, D4) | PL + counsel | Week 8 | Production region, pilot |
| **PRE-04** | Google Cloud project, Vision & Speech APIs enabled, data-processing terms accepted | OPS | Week 2 | BE-20, BE-30 |
| **PRE-05** | SMS OTP gateway contract (BD vendor) + SES sender domain | PL | Week 3 | BE-03 |
| **PRE-06** | Recruit LEGAL SME; agree the time budget for verification and evals | PL | Week 1 | DATA-08, EVAL-* |
| **PRE-07** | Collect **150 anonymized FIRs** (printed + handwritten) with consent / anonymization protocol | LEGAL + PL | Week 6 | EVAL-04, EVAL-05 |
| **PRE-08** | Record **5 h of legal dictation** (10+ speakers, code-switched) | LEGAL + QA | Week 7 | EVAL-06 |
| **PRE-09** | Apple Developer & Google Play Console accounts; app names reserved | PL | Week 6 | MOB-12 |
| **PRE-10** | Pilot cohort: recruit 20–30 lawyers + 5 judicial officers (if permitted) + 50 citizens | PL + LEGAL | Week 10 | PIL-* |
| **PRE-11** | Check the Supreme Court website's terms of use for reusing SCOB judgments and their PDFs; record the outcome | PL + counsel | Week 5 | JUD-03 (production crawl) |
| **PRE-12** | LEGAL writes the **case-law eval set**: 60 questions with expected judgment(s) and paragraph | LEGAL | Week 8 | EVAL-09 |

---

## 4. Sprint 1 (Weeks 1–2) — Foundations & Scraper

**Goal:** monorepo, CI, infrastructure skeleton, DB schema and the first Acts scraped and versioned.

### Platform & DevOps
- [~] **OPS-01** Create the pnpm monorepo layout (`apps/api`, `apps/worker`, `apps/web`, `packages/*`, `mobile/`, `infra/`, `evals/`) per TRD §3.2 · *Done when:* `pnpm install && pnpm build` passes
- [~] **OPS-02** `docker-compose` for local dev: mysql:8.4, redis, qdrant, SeaweedFS (S3), TEI (CPU, bge-m3 + reranker) · *Done when:* `docker compose up` brings up every service healthy
- [x] **OPS-03** GitHub Actions CI: lint, `tsc --noEmit`, Vitest, Testcontainers integration, Gitleaks, Semgrep, Trivy · *Done when:* a PR shows a green pipeline in under 10 min
- [ ] **OPS-04** Terraform base: VPC, private subnets, RDS MySQL 8.4 (dev), ElastiCache, S3 (SSE-KMS), ECR, Secrets Manager, ECS cluster (dev) · *Depends:* OPS-01
- [x] **OPS-05** `packages/config`: Zod-validated env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, DB, Redis, Qdrant, Google creds, JWT keys). The app refuses to boot if config is invalid

### Database
- [x] **BE-01** Drizzle schema for all tables in TRD §4.2: users, statutes, statute_sections (+ `current_key` generated column, FULLTEXT ngram), section_chunks, crpc_schedule_metadata, case_files, case_artifacts, artifact_revisions, conversations, messages, otp_challenges, refresh_tokens, credential_reviews, scrape_runs/events, outbox_events, audit_log · *Done when:* migrations apply cleanly on an empty DB
- [x] **BE-02** DB users & grants (`app_api`, `app_worker`, `app_scraper`, `app_migrate`) per TRD §4.3 · Citizen-case-conversation trigger (TRD §4.2)
- [x] **BE-02a** `packages/db/scoped.ts` scoped repository + ESLint `no-restricted-imports` ban on raw access to tenant tables · *Done when:* lint fails on a deliberate violation

### Corpus
- [x] **DATA-01** Spike: map `bdlaws.minlaw.gov.bd` URL patterns (index, Act detail, print view) and HTML structure for 10 representative Acts (English pre-1987, Bangla post-1987, heavily amended e.g. CrPC) · *Output:* `scraper/README.md` with selectors and URL config
- [x] **DATA-02** `packages/legal-text`: NFC + Bangla variant normalizer, Bangla↔ASCII digits, section-key normalizer (`৫৬১ক` → `561A`), SHA-256 hashing · *Done when:* ≥ 95% unit-test coverage
- [x] **DATA-03** Crawler worker: undici + 1 req/s limiter, robots.txt, conditional GET, backoff, raw HTML snapshots to S3 (TRD §6.1)
- [x] **DATA-04** Cheerio parser: Act → Chapter → Section → Sub-section → Footnotes; footnote action parser (substituted/inserted/omitted, amending Act, date) (TRD §6.2)
- [x] **DATA-05** Versioning transaction + outbox writes + 20% change safety valve (TRD §6.3) · *Done when:* the integration test "amend → archive → new current" passes, including concurrent workers

**Sprint 1 demo:** scrape 10 Acts → re-run → no new versions → edit one snapshot by hand → re-run → v2 created, v1 archived with `valid_to`.

---

## 5. Sprint 2 (Weeks 3–4) — Corpus Live, Auth & Retrieval Core

**Goal:** top 50 Acts searchable, with point-in-time support (**M1**); auth and the core API skeleton.

### Corpus & Search
- [x] **DATA-06** Chunker (350–500 tokens, split on sub-section/proviso boundaries, heading prefixed) + outbox worker → TEI embed → Qdrant upsert/payload update (TRD §4.4, §6.4) · *Done when:* outbox replay is idempotent (test)
- [x] **DATA-07** Qdrant collection setup script (HNSW params, payload indexes) + `reindex --all` command with alias swap
- [ ] **DATA-08** Ingest the **top 50 Acts** (SRS Phase 1 list: Penal Code, CrPC, CPC, Evidence Act, Limitation Act, Specific Relief Act, Nari-O-Shishu, Cyber Security Act, NI Act, Labour Act, …)
- [ ] **DATA-09** Schedule II extraction script → draft rows → **LEGAL verifies every row** in a review sheet → import with `verified_by/at` (TRD §6.5) · *Done when:* 100% of rows verified
- [~] **DATA-10** Nightly BullMQ repeatable job + weekly full re-crawl + scrape_runs dashboard data

### API Core
- [x] **BE-03** Auth: OTP request/verify (SMS + email), ES256 JWT, refresh rotation with reuse detection, `/auth/login` alias (TRD §12.1) · *Depends:* PRE-05 (a mock SMS provider is used until it lands)
- [x] **BE-04** `/me`, `/me/credential`, verification status, `requireRoles` + `requireVerified` hooks
- [~] **BE-05** Fastify app skeleton: Zod type provider, OpenAPI at `/docs`, RFC 9457 errors, helmet, CORS, rate limiting (Redis), pino redaction, OpenTelemetry
- [x] **BE-06** Statutes read API: `/statutes`, `/statutes/{act}`, `/sections/{sec}?as_of=`, `/versions` + Redis cache (generation-keyed, TRD §11.3)
- [ ] **BE-07** Retrieval service: query normalizer, explicit-citation detector, Qdrant dense + MySQL FULLTEXT sparse in parallel, RRF fusion, TEI rerank, sufficiency gate, point-in-time filters (TRD §7.1)

### Evals
- [ ] **EVAL-01** Eval runner skeleton (`evals/`, Node) with per-run result storage and diffing
- [ ] **EVAL-02** Point-in-time eval: 40 amended sections × before/after dates → **100% required for M1**
- [ ] **EVAL-03** LEGAL starts writing the **Q&A golden set** (target: 300 questions + expected sections by Week 6; 100 by Week 4)

**M1 check (end of Week 3–4):** nightly sync green 5 days in a row · EVAL-02 = 100% · Schedule II 100% verified.

---

## 6. Sprint 3 (Weeks 5–6) — RAG Assistant & Web App

**Goal:** an internal beta of the web assistant, with citations, conversations and the verifier (**M2**).

### AI & Assistant
- [x] **BE-08** `packages/providers/llm`: `createAnthropic({ baseURL, apiKey })` from env, model IDs from config, circuit breaker, timeouts/retries, telemetry with input/output recording off (TRD §7.6)
- [x] **BE-09** **Relay checks** (feeds decision D10): confirm `claude-opus-5-5` is accepted unchanged, prompt caching works (cache-read tokens > 0 on repeat), effort/thinking provider options are forwarded, added latency is measured · *Output:* short report in `docs/relay-verification.md`
- [ ] **BE-10** Role system prompts v1 (CITIZEN / LAWYER / JUDGE) in `packages/prompts` — **LEGAL reviews**
- [ ] **BE-11** Streaming citation validator (`TransformStream`, `[n]` buffering, invalid-marker stripping, flags, metrics) (TRD §7.4) · *Done when:* unit tests for split brackets and unknown refs pass
- [x] **BE-12** Conversations API: general conversations CRUD, case conversation auto-created with each Lawyer/Judge case, Citizen blocked (TRD §4.2, §5.1)
- [ ] **BE-13** `POST /assistant/query` SSE: meta/token/citation/done/error events, abort on client disconnect → `INTERRUPTED`, NO_PROVISION path, message persistence with usage telemetry
- [ ] **BE-14** Case context builder (case JSON + drafts summary + offense date → as-of retrieval) + conversation summarization job (TRD §7.2)
- [x] **BE-15** Cases API: CRUD, `If-Match` optimistic concurrency, `updated_since` sync, soft-delete tombstones (TRD §5.4)
- [x] **QA-01** **Tenant isolation suite** across every route + route-coverage check in CI (TRD §4.3)

### Web
- [x] **WEB-01** Next.js scaffold, Tailwind, `next-intl` (BN/EN), Noto Sans Bengali, typed API client from `packages/contracts`
- [x] **WEB-02** Auth screens: language picker, login, OTP, profile setup, credential entry, pending-verification banner (App Flow §3)
- [ ] **WEB-03** Assistant chat: SSE parser via `fetch` stream, streaming render, citation chips, retry on interrupt, conversation history sidebar (rename/delete) (App Flow §4–5)
- [x] **WEB-04** Law Verifier side panel: verbatim text, footnotes, Schedule II strip, version history & diff (Lawyer/Judge) (App Flow §7.1)
- [x] **WEB-05** Law Library: search, Act tree, section pages (public, SSR/ISR) (App Flow §7.2)
- [x] **WEB-06** Case list + workspace shell (Overview, Documents, Drafts, Conversation tabs, shown by role) (App Flow §8)

### Case Law — SCOB harvester (Module D, SRS §4.4, TRD §6A)
- [ ] **JUD-01** Spike: SCOB index, both list templates (per-issue AD/HD and generic `bulletin_list.php`), 10 sample PDFs across old/new issues and both divisions (text layer vs scanned, English vs Bangla, paragraph and date formats); count judgments per issue · *Output:* `apps/worker/src/scob/README.md` + `scob-source-config.ts` + saved fixtures
- [ ] **JUD-02** Schema: `judgments`, `judgment_statute_refs`, `judgment_chunks`, `judgment_revisions` (TRD §4.2) + grants for `app_scraper` + outbox event types · *Done when:* migrations apply on an empty DB and the grants test covers the new tables
- [ ] **JUD-03** Crawler + list parser in `apps/worker/src/scob`: reuse the §6.1 HTTP client, own 1 req/s limiter, robots.txt, snapshots to S3, weekly BullMQ job, `--scob-backfill` CLI (TRD §6A.1–6A.2) · *Depends:* JUD-01, JUD-02 · *Done when:* parser tests pass on both templates' fixtures
- [ ] **JUD-04** PDF pipeline: hash, `qpdf`, `pdftotext`, Bijoy check, paragraph splitter, metadata rules + verified LLM fallback, `NEEDS_REVIEW` path, revision on changed PDF (TRD §6A.3) · *Depends:* JUD-03 · OCR fallback waits for BE-20 (those judgments stay `NEEDS_REVIEW` until then); Bijoy conversion: `convertBijoyDocument` from DATA-11
- [ ] **JUD-05** Statute linking: run the section detector + Act dictionary over key words and body → `judgment_statute_refs` · *Depends:* JUD-04, DATA-12 (a first version over key words only can start before DATA-12)
- [ ] **JUD-06** Judgment chunker + outbox handler → TEI → Qdrant `judgment_chunks` (alias + reindex like DATA-07); backfill all issues · *Depends:* JUD-04, DATA-06 · *Done when:* outbox replay is idempotent (integration test) and EVAL-10 passes
- [ ] **EVAL-10** Judgment-metadata eval: 50 judgments checked by hand against the PDF (TRD §14.2)

### Evals
- [ ] **EVAL-07** Run the Q&A golden set (300) + cross-lingual set (100) on staging; calibrate the sufficiency threshold τ · *Pass bars:* TRD §14.2
- [ ] **OPS-06** Staging environment on ECS (api, worker, qdrant, TEI GPU) + deploy pipeline with the eval gate

**M2 check (end of Week 6):** internal users can log in on staging, ask questions and get cited answers, and open the verifier · EVAL-07 passes · first token ≤ 1.5 s p90 · **D10 relay decision recorded** · all SCOB issues ingested and indexed, EVAL-10 passes.

---

## 7. Sprint 4 (Weeks 7–8) — FIR Scan Pipeline & Voice Query

**Goal:** documents can be uploaded and analyzed end to end, and push-to-talk works.

### Scan
- [ ] **BE-20** `OcrProvider` (Google Vision) + `providers` interface · *Depends:* PRE-04
- [x] **BE-21** Upload flow: presigned PUT URL, `HeadObject` check, magic-byte validation (TRD §8.1, §12.6). `qpdf` sanitization moved to BE-22 (needs the binary in the worker image)
- [x] **BE-22** BullMQ scan flow stages 1–2: `qpdf` sanitization (from BE-21) + `pdftotext`/`pdftoppm`/`mammoth`/`sharp` pre-processing, Bijoy detection + converter (TRD §8.2)
- [x] **DATA-11** Bijoy→Unicode converter in `packages/legal-text` with a test corpus of ≥ 200 strings
- [x] **DATA-12** Section detector (Bangla/English patterns, letters, `302/34` expansion, Act dictionary, `act_inferred`) — ≥ 300 test strings (TRD §8.4)
- [x] **BE-23** Stage 3: `generateObject` FIR extraction with the Zod schema (TRD §8.3)
- [x] **BE-24** Stages 4–5: Bangla/English date parser, delay calculation, detector merge, Schedule II join, `NOT_IN_VERIFIED_SCHEDULE` handling
- [x] **BE-25** Stage 6: role analyses (Citizen explanation / Lawyer ingredient audit / Judge charge matrix) with pinned sources + citation validation
- [x] **BE-26** Artifact status SSE (`/events`) via Redis pub/sub · field-correction PATCH + `/reanalyze` · push notification hook (FCM)
- [x] **WEB-07** Upload modal (drag-drop, validation) + document card with progress stepper (App Flow §9.2–9.3)
- [~] **WEB-08** Scan Result screen: FIR details, editable fields, Schedule II table, role-specific analysis, "Ask about this document" routed by role (App Flow §9.4)

### Voice Query
- [ ] **BE-30** `SttProvider` (Google STT v2) + `/voice/transcribe-query` with ffmpeg transcoding · *Depends:* PRE-04
- [ ] **DATA-13** Legal glossary v1 YAML (≥ 400 entries, BN/EN/romanized variants) — **LEGAL reviews** · phrase-set upload to STT
- [ ] **DATA-14** Glossary corrector (trie + edit distance + phonetic key) + spoken-number → citation converter (TRD §9.3)
- [ ] **WEB-09** Push-to-talk mic in chat: hold to record, slide to cancel, editable transcript, auto-send (App Flow §6)

### Case Law — search & citations
- [ ] **JUD-07** Judgments API (`/judgments`, `/judgments/{id}`, `/statutes/{act}/sections/{sec}/judgments` with the `older_than_current_version` flag) + case-law arm in retrieval + `JUDGMENT` sources in prompts + validator `kind` and the `JUDGMENT_ONLY_CITATION` / `UNSOURCED_CASE_REFERENCE` flags (TRD §5.1, §6A.5, §7.1–7.4) · *Depends:* JUD-06, BE-07, BE-11, BE-13 · *Done when:* validator unit tests cover judgment refs and the case-law arm stays within the §11.1 budget
- [ ] **WEB-12** Case Law in the Law Library (search, filters, Judgment Viewer with paragraph anchors and original-PDF link), judgment chips in chat, "Judgments on this section" block in the verifier (App Flow §5, §7.1, §7.3)

### Mobile (start)
- [ ] **MOB-01** Flutter scaffold: go_router, Riverpod, bottom tabs, i18n, secure storage, generated API client
- [ ] **MOB-02** Auth flow screens (App Flow §3)

### Evals
- [ ] **EVAL-04** FIR extraction eval (150 FIRs) · **EVAL-05** OCR character-error-rate eval · *Depends:* PRE-07
- [ ] **EVAL-08** Vendor benchmark checkpoint for **D1 (OCR)** and **D2 (STT)** — keep Google or switch before Sprint 5
- [ ] **EVAL-09** Case-law retrieval & citation eval (60 questions, TRD §14.2) · *Depends:* PRE-12, JUD-07

---

## 8. Sprint 5 (Weeks 9–10) — Live Dictation, Export & Mobile Core

**Goal:** web features complete (**M3**) and the mobile core flows working.

### Dictation & Export
- [ ] **BE-31** Dictation WebSocket: auth-first frame, PCM/Opus input, STT stream rotation with overlap de-duplication, interim/final/command frames, Redis concurrency limits, audio tee to S3 (TRD §5.3, §9.2)
- [x] **BE-32** Draft templates (Lawyer: bail petition, legal notice, argument notes, witness summary, plaint; Judge: bench notes, order sheet, issue-framing, judgment summary) + `POST /cases/{id}/drafts`
- [x] **BE-33** Draft PATCH with last-write-wins + `artifact_revisions` preservation + `X-Conflict-Preserved` (TRD §5.4)
- [ ] **BE-34** Export worker: `docx` builder + Playwright `page.pdf()` with Bangla fonts, presigned download, 24 h lifecycle (TRD §10) · Bangla rendering snapshot tests
- [ ] **BE-35** GD templates + guided voice-fill API for Citizens (App Flow §11)
- [~] **WEB-10** TipTap draft editor + dictation mode (AudioWorklet 16 kHz PCM, interim decorations, corrections underlined with undo, autosave indicator) (App Flow §10)
- [ ] **WEB-11** Export sheet (DOCX/PDF) + GD guided form (App Flow §11–12)

### Mobile
- [ ] **MOB-03** Home chat: SSE streaming, citations, conversation history; verifier as a bottom sheet
- [ ] **MOB-04** Push-to-talk (`record`) → transcribe → ask
- [ ] **MOB-05** Scanner: ML Kit (Android) / VisionKit (iOS) → page review → document details → presigned upload (App Flow §9.1)
- [ ] **MOB-06** Cases list + workspace + scan result screen + processing status
- [ ] **MOB-07** Offline queue (`drift`) for scans and draft edits; FCM push for scan completion

### Evals & Quality
- [ ] **EVAL-06** STT WER + glossary accuracy eval · *Depends:* PRE-08
- [ ] **QA-02** Playwright E2E for web: login → ask → verify; upload FIR → result; dictate → export

**M3 check (end of Week 9–10):** all web flows in App Flow §3–§13 work on staging · EVAL-04/05/06/09 pass bars met · FIR ≤ 6 s and dictation ≤ 800 ms p90 on staging.

---

## 9. Sprint 6 (Weeks 11–12) — Full Corpus, Hardening & Pilot

**Goal:** production launch for the pilot (**M4**).

### Corpus & Admin
- [ ] **DATA-15** Expand ingestion to all **~1,480 Acts** (spot-instance embedding backfill); monitor quarantines and fix parser edge cases
- [ ] **BE-40** Admin Console API + minimal web UI: credential verification queue, sync dashboard (bdlaws + SCOB runs), judgment review queue, Schedule II editor with audit log, admin MFA + IP allowlist (App Flow §15.2)
- [ ] **BE-41** Amendment notice for affected case files (App Flow §15.1)

### Mobile
- [ ] **MOB-08** Live dictation on mobile (PCM → WebSocket) + draft editor (basic rich text)
- [ ] **MOB-09** Export via the OS share sheet; settings & profile; logout clears local cache
- [ ] **MOB-13** Case Law in the Library tab + judgment bottom sheet from chat citations (App Flow §2.2, §7.3) · *Depends:* JUD-07
- [ ] **MOB-10** Security: certificate pinning, SQLCipher, `FLAG_SECURE` on case screens (D8)
- [ ] **MOB-11** Flutter integration tests: scan → result, push-to-talk
- [ ] **MOB-12** Fastlane → TestFlight + Play internal track · *Depends:* PRE-09

### Hardening
- [ ] **QA-03** k6 load tests: 50 SSE streams, 20 dictation sockets, 100 scans / 10 min — SLA assertions (TRD §14.1)
- [ ] **QA-04** Security review: OWASP ASVS L2 checklist, isolation suite green, dependency/image scans clean, penetration test of auth & upload paths
- [ ] **OPS-07** Production environment (region per PRE-03 / D4), Multi-AZ RDS, backups & PITR tested with a **restore drill**, Qdrant snapshots
- [ ] **OPS-08** Dashboards & alerts (TRD §13.4): latency SLAs, invalid citations, relay circuit, outbox lag, queue depth, scraper health
- [ ] **OPS-09** Runbooks: relay outage → switch to direct Anthropic; scraper quarantine; restoring a deleted case; key rotation

### Pilot
- [ ] **PIL-01** Privacy notice + terms + "not legal representation" disclaimer final (BN/EN) — counsel sign-off
- [ ] **PIL-02** Onboard the pilot cohort (PRE-10); verify lawyer/judge credentials in the admin console
- [ ] **PIL-03** In-app feedback button + weekly feedback review; bug triage rota

**M4 check (end of Week 12):** production live · load tests pass · no open high-severity findings · pilot users active · **real user data flows only through an approved AI endpoint (D10)**.

---

## 10. Critical Path

```text
PRE-06 Legal SME ──> DATA-09 Schedule II verified ──> M1 ──┐
DATA-01 Spike ──> DATA-04 Parser ──> DATA-05 Versioning ──> DATA-06 Embed ──> BE-07 Retrieval ──┐
PRE-01 Key rotation ──> BE-08 LLM provider ──> BE-09 Relay checks ──> BE-13 Assistant SSE ──> M2
PRE-04 Google ──> BE-20 OCR ──> BE-22..25 Scan pipeline ──> EVAL-04 (needs PRE-07 FIRs) ──> M3
JUD-01 Spike ──> JUD-03 Crawler ──> JUD-04 PDFs ──> JUD-06 Index ──> JUD-07 Case-law RAG ──> EVAL-09 (needs PRE-12) ──> M3
PRE-02 Relay DPA / direct-API fallback ─────────────────────────────────────────────> M4 (production data)
PRE-03 Legal hosting review ──> OPS-07 Production region ────────────────────────────> M4
```

The longest non-engineering lead times are **PRE-02, PRE-03, PRE-07 and PRE-10**. Start them in Week 1.

---

## 11. Risks & Mitigations

| # | Risk | Impact | Likelihood | Mitigation | Owner |
| :--- | :--- | :---: | :---: | :--- | :--- |
| R1 | bdlaws HTML is inconsistent across Acts, or changes layout | High | High | Snapshots + reproducible parsing; 20% change safety valve; parser fixtures per Act family; budget parser fixes in S6 | DATA |
| R2 | AI relay fails due diligence, is unreliable, or doesn't forward caching/effort | High | Medium | BE-09 checks in S3; circuit breaker; direct Anthropic endpoint ready as a config switch (D10) | PL / BE |
| R3 | Bangla handwritten FIR OCR quality is below the pass bar | High | Medium | Vendor benchmark (EVAL-08); editable fields + re-analysis; low-confidence banner; section detector cross-check | BE / DATA |
| R4 | First-token latency over 1.5 s (relay hop + model) | Medium | Medium | Effort tuning per route, prompt caching, smaller source set, early "sources found" event; measure from S3 | BE |
| R5 | Legal SME availability slips (Schedule II, golden set) | High | Medium | Contract hours up front (PRE-06); prioritize Schedule II for the top 20 offenses first | PL |
| R6 | FIR sample collection delayed (privacy/consent) | Medium | Medium | Start PRE-07 in Week 1; use public-domain sample FIRs + synthetic FIRs for early development | PL / LEGAL |
| R7 | STT accuracy on code-switched legal speech | Medium | Medium | Phrase-set boosting + glossary corrector; benchmark Azure as an alternative (D2) | DATA |
| R8 | Tenant data leak through a missed owner filter (MySQL has no row-level security) | Critical | Low | Scoped repos only, lint ban, route-coverage isolation suite in CI, code review checklist | BE / QA |
| R9 | Data-residency ruling requires in-country hosting | High | Low–Med | Portable stack (containers, MySQL, S3-compatible); decide by Week 8 (PRE-03) | PL / OPS |
| R10 | Mobile starts late and compresses S6 | Medium | Medium | MOB starts in S4; mobile reuses the API with no mobile-only endpoints; scope cut: mobile dictation can move post-pilot | PL |
| R11 | SCOB site unreachable from the dev network, or its two list templates differ more than expected | Medium | Medium | Same approach as DATA-01: spike from a network that reaches it, fixtures per template, selectors in config | DATA |
| R12 | Many SCOB PDFs are scanned or in Bijoy fonts, so text extraction stalls until OCR/Bijoy work lands | Medium | Medium | Measure the share in JUD-01; ingest text-layer PDFs first; `NEEDS_REVIEW` queue for the rest | DATA |
| R13 | The model overstates or misattributes a court's holding | High | Medium | Cite paragraph-level chunks only; key-ratio paragraphs chunked on their own; judgment-only answers flagged; EVAL-09 with 0 fabricated cases as a release gate | BE / LEGAL |
| R14 | Case-law work in S3–S4 delays core RAG (M2) | Medium | Medium | Scope cut order: WEB-12/MOB-13 UI first, then the RAG case-law arm (search page alone can ship); harvesting continues regardless | PL |

---

## 12. Definition of Done (every task)

- [ ] Code merged to `main` through a reviewed PR with a green CI pipeline
- [ ] Unit/integration tests added; tenant-owned routes registered in the isolation suite
- [ ] API changes reflected in the Zod contracts and the generated OpenAPI; no breaking change without versioning
- [ ] Logs contain no document text, transcripts, queries or secrets
- [ ] User-visible text available in **Bangla and English**
- [ ] Deployed to staging and smoke-tested; eval gate green if prompts, models or retrieval changed
- [ ] Docs updated (README / TRD section) if behavior or config changed

---

## 13. Scope Guardrails (Not in MVP)

To protect the 12-week timeline, these are explicitly **out of scope**:
- Sharing or collaboration on case files between users
- Payments / subscriptions
- Case law beyond **SCOB reported judgments**: Bengali translations of judgments, unreported judgments, cause lists, subordinate-court and tribunal judgments, paid law reports (DLR, BLD, etc.). SCOB judgments were brought into scope on 2026-11-04 (D12)
- E-filing or submitting GDs to police systems
- AI agents with tools / web browsing
- Offline AI or on-device models
- Languages other than Bangla and English

Changes to this list need PL approval and a re-plan of the affected sprint.

---

## 14. Decision Log (from TRD §17)

| ID | Decision | Decide By | Status |
| :--- | :--- | :---: | :--- |
| D1 | OCR vendor | Week 8 (EVAL-08) | Open — default Google Vision |
| D2 | STT vendor | Week 8 (EVAL-08) | Open — default Google STT v2 |
| D3 | Mobile framework | Week 1 | Default Flutter — confirm at kickoff |
| D4 | Cloud region / residency | Week 8 (PRE-03) | Open |
| D5 | Smaller model for some routes | Week 10 (after evals) | Open — default `claude-opus-5-5` everywhere |
| D6 | Voice audio retention | Week 6 | Open |
| D7 | SMS vendor | Week 3 | Open |
| D8 | Screenshot blocking | Week 11 | Default on (Android) |
| D9 | Vector/keyword search engine | Week 6 (EVAL-07) | Default Qdrant + MySQL FULLTEXT |
| D10 | **AI relay in production** | **Week 6 (BE-09 + PRE-02)** | **Open — blocks real user data** |
| D11 | Qdrant hosting | Week 4 | Default self-hosted |
| D12 | Case-law scope | 2026-11-04 | **Decided:** SCOB reported judgments (AD + HCD) in MVP; everything else post-MVP |
