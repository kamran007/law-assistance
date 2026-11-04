# Technical Requirements Document (TRD)
## Project: BD-LawAssist — AI Legal Research, Document Analysis & Voice Dictation Platform (MVP)

| Attribute | Details |
| :--- | :--- |
| **Document Scope** | How the MVP will be built: technology stack, service design, data model, API contracts, AI pipelines, security, infrastructure, testing |
| **Inputs** | `bd_lawassist_mvp_software_requirements_specification.md` (SRS) · `app_flow.md` (App Flow) |
| **Audience** | Backend, web, mobile, ML and DevOps engineers |
| **Status** | Draft v1.2 — 2026-11-04 (backend: Node.js · database: MySQL · AI: Anthropic via Vercel AI SDK). v1.2 adds Module D: Supreme Court judgments (§6A) |

> **Conventions.** `MUST` = required for MVP launch. `SHOULD` = strongly recommended, may slip to post-pilot. Items marked **🔶 Decision** are technology choices made in this document that the team may revisit. Section 17 lists them all.

---

## 1. Technical Goals & Constraints

| # | Goal | Derived From | Measurable Target |
| :--- | :--- | :--- | :--- |
| G1 | Never present an uncited or unverifiable statutory claim or case-law reference | SRS NFR 1 | 100% of citation chips resolve to a `statute_sections` or `judgments` row; 0 invalid citations reach the client |
| G2 | Bail / cognizance / compoundability status is never AI-generated | FR-B3 | Shown only from `crpc_schedule_metadata`; covered by unit tests |
| G3 | Law text is version-correct for the requested date | FR-A3, FR-A4 | Point-in-time query returns the version whose `[valid_from, valid_to)` contains the date |
| G4 | Low latency | SRS NFR 4 | Q&A first token < 1.5 s (p90) · dictation word < 800 ms (p90) · 1-page FIR breakdown < 6 s (p90) |
| G5 | Strict tenant isolation & confidentiality | SRS NFR 3 | Every query on user data is scoped by owner in the data-access layer (§4.3); AES-256 at rest; TLS 1.2+ in transit |
| G6 | One backend for both clients | SRS §2 | Web and mobile use only the public `/api/v1` surface |
| G7 | Bangla-first | SRS NFR 2 | `utf8mb4` end to end; Bangla numerals parsed; correct Bangla text shaping in PDF exports |

**Constraints**
- 12-week MVP and a small team, so prefer **managed services** and **TypeScript everywhere**: backend, workers, web. Mobile is the exception (§15.2).
- **Backend language: Node.js. Primary database: MySQL.** These are fixed project decisions.
- **AI provider:** Anthropic models accessed through the **Vercel AI SDK `@ai-sdk/anthropic` provider pointed at a custom base URL** (an API relay), as set in the project's provider config (§7.6).
- The source corpora (`bdlaws.minlaw.gov.bd` for statutes, the Supreme Court Online Bulletin on `supremecourt.gov.bd` for judgments) are public government websites with no API. Scraping MUST be polite and resilient to layout changes.
- Users upload sensitive criminal-case material. Every third-party processor (LLM relay, LLM provider, OCR, STT) MUST be contractually barred from training on the data or retaining it beyond what processing needs (§12.4).

---

## 2. Technology Stack

| Layer | Technology | Rationale |
| :--- | :--- | :--- |
| **Runtime** | **Node.js 22 LTS** · TypeScript 5 (strict) · pnpm workspaces | One language across backend, workers and web; shared types |
| **API framework** | **Fastify 5** · `@fastify/websocket` · `@fastify/swagger` · `fastify-type-provider-zod` · Zod | Fast, low overhead; first-class SSE, WebSocket and OpenAPI generation from Zod schemas |
| **Async workers** | **BullMQ** on **Redis 7** (queues, repeatable jobs for scheduling) | Native Node queue with retries, backoff, rate limiting, flows (job chains) and cron |
| **Primary database** | **MySQL 8.4 LTS** (InnoDB, `utf8mb4` / `utf8mb4_0900_ai_ci`) | Source of truth for users, cases, conversations, statutes, versions and Schedule II |
| **ORM / migrations** | **Drizzle ORM** (`mysql2` driver) + `drizzle-kit` | Type-safe SQL close to the metal; supports MySQL JSON, generated columns and raw SQL where needed |
| **Vector search** | **Qdrant** (self-hosted container) | MySQL Community has no approximate-nearest-neighbour vector index. Qdrant stores the `Vector(1024)` embeddings with payload filters for point-in-time queries. It is a **derived index**, rebuildable from MySQL at any time (§4.4) |
| **Keyword search** | MySQL `FULLTEXT` (InnoDB, **ngram parser**) on section text, headings and Act titles | Keyword half of the hybrid search, without another engine |
| **LLM** | **Anthropic Claude** via **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`) with a custom `baseURL` · model `claude-opus-5-5` | `streamText` for answers, `generateObject` with Zod schemas for structured extraction (§7.6) |
| **Embeddings** | **BAAI `bge-m3`** (1024-dim) served by **Hugging Face Text Embeddings Inference (TEI)** | Multilingual including Bangla; output dimension matches SRS `Vector(1024)`. TEI is a prebuilt container with an HTTP API, so no Python code is needed |
| **Reranker** | **BAAI `bge-reranker-v2-m3`** on a second TEI container (`/rerank`) | Cross-lingual reranking (Bangla query → English statute) |
| **OCR** 🔶 | **Google Cloud Vision** `DOCUMENT_TEXT_DETECTION` (`@google-cloud/vision`, language hints `bn`, `en`) behind an `OcrProvider` interface | Production-grade Bangla printed and handwritten OCR; swappable |
| **Speech-to-text** 🔶 | **Google Cloud Speech-to-Text v2** streaming (`@google-cloud/speech`, `bn-BD` + `en-US` alternative, phrase-set adaptation) behind an `SttProvider` interface | Streaming interim results meet the 800 ms target |
| **Image / PDF processing** | `sharp` (resize, normalize, CLAHE) · Poppler `pdftoppm` / `pdftotext` (worker image) · `mammoth` (DOCX → text/HTML) | Mature native tooling callable from Node |
| **Web client** | **Next.js 15** (App Router) · TypeScript · Tailwind CSS · TanStack Query · **TipTap** editor | SSR for the public law library; TipTap gives structured rich text for drafts |
| **Mobile client** 🔶 | **Flutter 3** · Riverpod · `google_mlkit_document_scanner` (Android) / VisionKit (iOS) · `record` | One mobile codebase; native document-scanner UIs give auto-crop and deskew |
| **Document export** | `docx` (npm) for DOCX · **Playwright (headless Chromium) `page.pdf()`** for PDF, with embedded **Noto Sans/Serif Bengali** | Chromium uses HarfBuzz, which renders Bangla conjuncts correctly |
| **Infrastructure** 🔶 | AWS `ap-south-1` (Mumbai): ECS Fargate (API, workers, Qdrant) · EC2 GPU instance (TEI) · **RDS for MySQL 8.4** · ElastiCache Redis · S3 · CloudFront · Terraform | Closest major cloud region to Bangladesh; data residency still needs legal confirmation (§12.5) |
| **Observability** | OpenTelemetry (`@opentelemetry/sdk-node`) → Grafana (Tempo / Loki / Prometheus) · Sentry · `pino` logs | Distributed traces across the API, workers and AI calls |
| **CI/CD** | GitHub Actions · Docker · Terraform · Fastlane (mobile) | |

---

## 3. System Architecture

### 3.1 Deployable Units

```text
                    +-------------------+        +-------------------+
                    |   Next.js Web     |        |   Flutter Mobile  |
                    |   (CloudFront)    |        |   (iOS/Android)   |
                    +---------+---------+        +---------+---------+
                              |  HTTPS / SSE / WSS         |
                              +-------------+--------------+
                                            v
                              +---------------------------+
                              |  ALB (TLS termination,    |
                              |  WAF, sticky WS routing)  |
                              +-------------+-------------+
                                            v
+-------------------------------------------------------------------------------+
|  api  (Node.js 22 + Fastify, stateless, horizontally scaled)                   |
|  modules: auth · users · conversations · assistant(RAG) · statutes ·          |
|           judgments · cases · artifacts · scan · voice · dictation(WS) ·      |
|           export · admin                                                      |
+-----+-------------+--------------+--------------+---------------+--------------+
      |             |              |              |               |
      v             v              v              v               v
+-----------+ +-----------+ +------------+ +-------------+ +------------------+
| MySQL 8.4 | | Qdrant    | | Redis      | | S3 vault    | | TEI (GPU)        |
| (source   | | (vector   | | BullMQ,    | | (SSE-KMS)   | | bge-m3 embed     |
| of truth) | |  index)   | | cache,     | |             | | bge-reranker     |
+-----+-----+ +-----^-----+ | rate limit,| +------^------+ +------------------+
      ^             |       | pub/sub    |        |
      |             |       +-----+------+        |
      |             |             v               |
+-----+-------------+-------------------------------+---------------------------+
|  workers (Node.js + BullMQ) — queues:                                          |
|   scrape · ocr · analysis · embed · export · outbox                            |
+-------------------------------------------------------------------------------+
       |                        |                         |
       v                        v                         v
 bdlaws.minlaw.gov.bd   Google Vision / STT     AI relay (custom baseURL)
 supremecourt.gov.bd                             → Anthropic Claude
 (SCOB judgments)
```

### 3.2 Repository Layout (pnpm monorepo)

```text
apps/
  api/                       # Fastify server
    src/
      main.ts                # app factory, plugins, routers
      core/                  # config (zod-validated env), auth (JWT), db, scoped repos, logging
      modules/
        auth/  users/  conversations/  assistant/  retrieval/  statutes/
        judgments/  schedule/  cases/  artifacts/  scan/  voice/  export/  admin/
  worker/                    # BullMQ processors: scrape (bdlaws), scob (judgments), diff, embed, ocr, analyze, export, outbox
  web/                       # Next.js
packages/
  db/                        # Drizzle schema, migrations, scoped repository helpers
  contracts/                 # Zod schemas shared by API, worker and web (+ generated OpenAPI)
  providers/                 # LlmProvider, OcrProvider, SttProvider, EmbeddingProvider, VectorStore
  legal-text/                # normalizer, Bangla digits, section detector, Bijoy→Unicode, glossary
  prompts/                   # versioned role system prompts
mobile/                      # Flutter
infra/                       # Terraform
evals/                       # legal QA golden set, OCR/STT benchmarks (Node runner)
```

Each external engine sits behind a `packages/providers` interface, so OCR, STT, LLM or vector-store vendors can be swapped without touching business logic.

---

## 4. Data Model (MySQL 8.4)

The SRS defines eight entities (six core + two for case law). This TRD adds the tables the App Flow needs (conversations, auth, revisions, jobs, judgment chunks).

**MySQL conventions**
- **IDs:** UUID v7 stored as `BINARY(16)` (time-ordered, so it suits the InnoDB clustered index). The API exposes them as strings.
- **Timestamps:** `DATETIME(3)` in UTC, shown in `Asia/Dhaka`. Avoid `TIMESTAMP`, which hits the 2038 limit.
- **Text:** `utf8mb4` everywhere. Statute bodies use `MEDIUMTEXT`.
- **Structured fields:** the `JSON` type. Fields that are filtered on get generated columns with indexes.
- **Engine:** InnoDB. All foreign keys are declared.

### 4.1 Entity-Relationship Overview

```text
users 1---* case_files 1---* case_artifacts 1---* artifact_revisions
  |              |
  |              +---0..1 conversations (case conversation; LAWYER/JUDGE only)
  |
  +---* conversations (general; case_file_id NULL) 1---* messages

statutes 1---* statute_sections 1---* section_chunks  ──(mirrored)──> Qdrant collection "section_chunks"
statutes 1---* crpc_schedule_metadata
outbox_events (MySQL → Qdrant sync)        scrape_runs 1---* scrape_events

judgments 1---* judgment_chunks  ──(mirrored)──> Qdrant collection "judgment_chunks"
judgments 1---* judgment_statute_refs *---0..1 statutes
judgments 1---* judgment_revisions
```

### 4.2 Changes & Additions to SRS Entities

**`users`** (SRS 5.1) — add:
| Field | Type | Notes |
| :--- | :--- | :--- |
| `verification_status` | `ENUM('NOT_REQUIRED','PENDING','VERIFIED','REJECTED')` | Lawyer/Judge professional features need `VERIFIED` |
| `requested_role` | `ENUM` | The role chosen at signup. `role` stays `CITIZEN` until verification succeeds |
| `created_at`, `updated_at`, `deleted_at` | `DATETIME(3)` | Soft delete |

**`statutes`** (SRS 5.2) — add `source_url`, `language` (`EN`/`BN`), `raw_html_s3_key`, and a `FULLTEXT(title_en, title_bn) WITH PARSER ngram` index.

**`statute_sections`** (SRS 5.3) — changes:
| Field | Change | Reason |
| :--- | :--- | :--- |
| `semantic_embedding` | **Remove from MySQL.** Embeddings live per chunk in Qdrant (§4.4) | MySQL Community can't search vectors efficiently, and long sections need several chunks |
| `normalized_section_key` | **Add** `VARCHAR(16)`, e.g. `561A` | Normalized ASCII key for exact lookup from Bangla numerals |
| `valid_from_source` | **Add** `ENUM('AMENDMENT_FOOTNOTE','ENACTMENT_DATE','DETECTED_ON_SYNC')` | The scrape date is not the legal effective date. The system records how `valid_from` was derived, and the UI marks approximate dates |
| `valid_to` | `DATE NULL` | NULL = still valid |
| `current_key` | **Add** generated column `VARCHAR(64) AS (IF(is_current, CONCAT(HEX(statute_id), ':', normalized_section_key), NULL)) STORED` + **UNIQUE** | MySQL has no partial indexes. Because a UNIQUE index allows multiple NULLs, this guarantees exactly one current version per section |
| — | **Add** `FULLTEXT(marginal_heading, content_body) WITH PARSER ngram` | Keyword search arm |
| — | **Index** `(statute_id, normalized_section_key, valid_from, valid_to)` | Point-in-time lookup |

**`section_chunks`** (new — MySQL holds the text; Qdrant holds the vector)
| Field | Type | Notes |
| :--- | :--- | :--- |
| `chunk_id` | `BINARY(16)` PK | Also used as the Qdrant point ID |
| `section_id` | FK → `statute_sections` | Points to one section *version* |
| `chunk_index` | `SMALLINT` | |
| `chunk_text` | `TEXT` | ≈ 350–500 tokens, split on sub-section and proviso boundaries; each chunk carries the section heading |
| `embedding_model` | `VARCHAR(64)` | e.g. `bge-m3@<revision>`; triggers a re-embed when the model changes |
| `indexed_at` | `DATETIME(3) NULL` | Set once the Qdrant upsert is confirmed |

**`crpc_schedule_metadata`** (SRS 5.4) — add `offense_description`, `source_reference`, `verified_by`, `verified_at`, `effective_from`, `effective_to` (schedules also get amended).
Unique: `(statute_id, section_number, effective_from)`.

**`case_files`** (SRS 5.5) — add `title`, `created_at`, `updated_at`, `version INT` (optimistic concurrency), `deleted_at`.

**`case_artifacts`** (SRS 5.6) — changes:
| Field | Change |
| :--- | :--- |
| `artifact_type` | Extend the enum: `FIR_SCAN`, `CHARGE_SHEET`, `SEIZURE_LIST`, `COURT_ORDER`, `VOICE_DICTATION_DRAFT`, `COURT_ORDER_NOTE`, `GD_DRAFT` |
| `owner_user_id` | **Add** (denormalized) — every tenant query filters on it directly |
| `processing_status` | **Add** `ENUM('UPLOADED','OCR','EXTRACTING','SCHEDULE_LOOKUP','ANALYZING','READY','FAILED')` |
| `processing_error`, `ocr_confidence`, `page_count`, `mime_type`, `file_sha256` | **Add** |
| `role_analysis` | **Add** `JSON` — role-specific analysis, kept separate from the deterministic `structured_analysis` |
| `editable_document_html` | `MEDIUMTEXT` |
| `template_key`, `version` | **Add** |
| `file_storage_url` | **Rename** `file_storage_key` — store the S3 key and issue presigned URLs on demand |

**`artifact_revisions`** (new) — `revision_id`, `artifact_id`, `owner_user_id`, `version`, `editable_document_html`, `created_at`, `created_by_device`. Receives the overwritten copy when a sync conflict happens (App Flow §13).

**`conversations`** (new — App Flow §4, §5.2)
| Field | Type | Notes |
| :--- | :--- | :--- |
| `conversation_id` | `BINARY(16)` PK | |
| `owner_user_id` | FK | Tenant key |
| `case_file_id` | FK NULL, **UNIQUE** | `NULL` = general conversation (MySQL allows multiple NULLs under UNIQUE). Non-null = the single conversation of that case |
| `title`, `language`, `summary` | | `summary` = rolling summary of older turns (§7.2) |
| `created_at`, `updated_at`, `deleted_at` | | |

Rules:
- A Citizen's conversation MUST have `case_file_id IS NULL`. This is enforced in the service layer **and** by a `BEFORE INSERT/UPDATE` trigger that runs `SIGNAL SQLSTATE '45000'` when the owner's role is `CITIZEN` and `case_file_id` is set.
- A Lawyer/Judge case conversation is created in the same transaction as its case file.
- Deleting a case file cascades (`ON DELETE CASCADE`) to its conversation and messages.

**`messages`** (new)
| Field | Type | Notes |
| :--- | :--- | :--- |
| `message_id` | `BINARY(16)` PK | |
| `conversation_id` | FK | Index `(conversation_id, created_at)` |
| `owner_user_id` | | Denormalized tenant key |
| `role` | `ENUM('USER','ASSISTANT')` | |
| `content` | `MEDIUMTEXT` | Final rendered text with citation markers |
| `input_mode` | `ENUM('TEXT','VOICE')` | |
| `attached_artifact_id` | FK NULL | For "Ask about this document" |
| `citations` | `JSON` — `[{section_id, label}]` | Validated citations only |
| `retrieval_trace` | `JSON` | Chunk IDs + scores; for evaluation and audit; never sent to clients |
| `law_as_of_date` | `DATE NULL` | Set when point-in-time law was used |
| `model_id`, `input_tokens`, `output_tokens`, `latency_ms` | | Cost & performance telemetry |
| `status` | `ENUM('COMPLETE','INTERRUPTED','NO_PROVISION','ERROR')` | |
| `flags` | `JSON` | e.g. `INVALID_CITATION_STRIPPED` |

**Auth & operations tables** (new):
- `otp_challenges`: hashed code, expiry, attempts
- `refresh_tokens`: hashed, rotation family
- `credential_reviews`: admin decisions on Lawyer/Judge IDs
- `scrape_runs` / `scrape_events`
- `outbox_events`: `id`, `aggregate`, `aggregate_id`, `event_type`, `payload JSON`, `created_at`, `processed_at`
- `audit_log`: append-only; the application DB user has `INSERT` but not `UPDATE`/`DELETE` on it

**Case-law tables** (new — SRS 5.7, 5.8, Module D). Public reference data, **not** tenant tables; no `owner_user_id`.

**`judgments`** (SRS 5.7) — as in the SRS, with these MySQL details:
| Field | Change / Type | Notes |
| :--- | :--- | :--- |
| `judgment_id` | `BINARY(16)` PK (UUID v7) | |
| `issue_number`, `division`, `serial_number` | `SMALLINT`, `ENUM('AD','HCD')`, `SMALLINT` | **UNIQUE** `(source, issue_number, division, serial_number)` — the natural key from the SCOB listing |
| `full_text` | `MEDIUMTEXT` | Paragraph numbers kept as `[para n]` markers so chunks and citations can point to paragraphs |
| `stored_pdf_url` | **Rename** `stored_pdf_key` | S3 key `raw/scob/{issue}/{division}/{serial}/{pdf_sha256}.pdf`; presigned GET on demand |
| `decision_date_source` | **Add** `ENUM('PDF_RULE','PDF_LLM','MANUAL')` | How the date was obtained (§6A.3) |
| `listing_html_s3_key` | **Add** | Snapshot of the division list page the row came from |
| `normalized_section_keys` | **Add** `JSON` | Copy of resolved `statute_id:section_key` pairs, for filtering without a join |
| `created_at`, `updated_at` | `DATETIME(3)` | |
| — | **Add** `FULLTEXT(parties, key_words, summary) WITH PARSER ngram` | Keyword arm for case-law search |

**`judgment_statute_refs`** (SRS 5.8) — `reference_id`, `judgment_id` FK, `statute_id` FK NULL, `normalized_section_key` `VARCHAR(16)` NULL, `raw_reference_text`, `paragraph_numbers JSON`, `found_in ENUM('KEY_WORDS','BODY')`. Index `(statute_id, normalized_section_key)` for "judgments on this section".

**`judgment_chunks`** (new) — same shape as `section_chunks` with `judgment_id` FK instead of `section_id`, plus `paragraph_from`, `paragraph_to` `SMALLINT`.

**`judgment_revisions`** (new) — `revision_id`, `judgment_id`, `pdf_sha256`, `stored_pdf_key`, `full_text`, `replaced_at`. Receives the old text when a PDF at the same URL changes (FR-D4).

### 4.3 Tenant Isolation in MySQL

MySQL has no row-level security, so isolation is enforced in the **data-access layer** with several layers of protection:

1. **Scoped repositories only.** Every user-owned table (`case_files`, `case_artifacts`, `artifact_revisions`, `conversations`, `messages`) is reached only through `packages/db/scoped.ts`:
   ```ts
   const repo = scoped(db, ctx.userId);              // ctx from the verified JWT
   const file = await repo.caseFiles.findById(id);   // always adds WHERE owner_user_id = ctx.userId
   ```
   Raw Drizzle access to these tables is blocked outside `packages/db` by an ESLint `no-restricted-imports` rule, and CI fails on violations.
2. **Owner column on every child row** (`owner_user_id` is denormalized onto artifacts, revisions and messages), so no isolation check depends on a join.
3. **Not-found, never forbidden.** A resource owned by another user returns `404`, which doesn't reveal that it exists.
4. **Automated isolation suite.** An integration test seeds users A and B and calls **every** route with A's token against B's IDs, expecting `404`. New routes must be registered in this suite, enforced by a route-coverage check.
5. **Separate DB users:**
   - `app_api`: DML on app tables, no DDL.
   - `app_worker`: same DML, and workers that handle user data receive `owner_user_id` in the job payload and use the same scoped repos.
   - `app_scraper`: rights only on `statutes`, `statute_sections`, `section_chunks`, `judgments`, `judgment_statute_refs`, `judgment_chunks`, `judgment_revisions`, `scrape_*` and `outbox_events`; no access to user tables.
   - `app_migrate`: DDL, used only in CI/CD.

### 4.4 Vector Index (Qdrant) & Consistency

- **Collection:** `section_chunks` with a 1024-dim vector and cosine distance, using an HNSW index with `m=16, ef_construct=128`.
- **Point ID:** the `chunk_id`.
- **Payload:** `{ section_id, statute_id, act_status, is_current, valid_from, valid_to, lang }`
  - `valid_from` and `valid_to` are RFC 3339 datetimes. An open-ended `valid_to` is stored as the sentinel `9999-12-31T00:00:00Z`, so range filters need no NULL handling.
  - Payload indexes on `is_current` (bool), `valid_from` / `valid_to` (datetime), `statute_id` (keyword) and `act_status` (keyword).
- **Consistency via the transactional outbox:** the versioning transaction (§6.3) writes `outbox_events` rows (`SECTION_VERSION_CREATED`, `SECTION_VERSION_CLOSED`) in the **same MySQL transaction** as the law change. The `outbox` worker reads unprocessed rows and calls TEI (embed) and then Qdrant (upsert or payload update). It marks `processed_at` only after Qdrant confirms. Replays are safe because the operations are idempotent.
- **Source of truth:** retrieval takes only `chunk_id`s and scores from Qdrant. Text, versions and citations are always re-read from MySQL by ID, so a stale vector can never show stale text.
- **Rebuild:** `pnpm worker reindex --all` rebuilds the collection from MySQL, for example after an embedding model upgrade, using an alias swap so search has no downtime.
- **Second collection `judgment_chunks`** (Module D): same vector settings and the same alias/rebuild pattern. Payload `{ judgment_id, division, issue_year, decision_date, section_keys[], statute_ids[], lang, paragraph_from, paragraph_to }`, with payload indexes on `division`, `issue_year`, `statute_ids` and `section_keys`. Judgments are not versioned, so there are no `is_current` / `valid_*` filters. Outbox events `JUDGMENT_UPSERTED` / `JUDGMENT_REMOVED` drive it, with the same idempotent re-read-MySQL handlers.

---

## 5. API Specification

Base path `/api/v1`. JSON over HTTPS. Auth: `Authorization: Bearer <access JWT>`. Request and response schemas are Zod definitions in `packages/contracts`, and the OpenAPI 3.1 document is generated from them by `@fastify/swagger`. Errors use RFC 9457 problem details:

```json
{ "type": "https://lawassist.bd/errors/validation", "title": "Invalid section", "status": 422, "detail": "...", "code": "SECTION_NOT_FOUND" }
```

### 5.1 Endpoint Catalogue

The SRS defines 10 endpoints (✱). The rest are needed by the App Flow.

| Method | Path | Purpose | Roles |
| :--- | :--- | :--- | :--- |
| POST | `/auth/otp/request` | Send OTP to phone/email | public |
| POST | `/auth/otp/verify` | Verify OTP → `{access, refresh, is_new_user}` | public |
| POST | ✱ `/auth/login` | Kept as an alias of `otp/verify` for SRS compatibility | public |
| POST | `/auth/refresh` | Rotate refresh token | public |
| POST | `/auth/logout` | Revoke the refresh family | any |
| GET / PATCH | `/me` | Profile, preferred language | any |
| POST | `/me/credential` | Submit Bar Council / Judicial ID | any |
| GET / POST | `/conversations` | List / create **general** conversations (`case_file_id` always null) | any |
| GET / PATCH / DELETE | `/conversations/{id}` | Read (paged messages), rename, delete | owner |
| POST | ✱ `/assistant/query` (SSE) | Ask a question in a conversation | any |
| GET | `/statutes?q=&status=&year=` | Search / list Acts | any |
| GET | `/statutes/{act_id}` | Act detail + chapter tree | any |
| GET | ✱ `/statutes/{act_id}/sections/{sec}?as_of=YYYY-MM-DD` | Verbatim text, status, footnotes, Schedule II strip; `as_of` restricted to LAWYER/JUDGE | any |
| GET | `/statutes/{act_id}/sections/{sec}/versions` | Version history | LAWYER, JUDGE |
| GET | `/statutes/{act_id}/sections/{sec}/judgments` | Judgments linked to this section (newest first, AD before HCD), with an `older_than_current_version` flag | any |
| GET | ✱ `/judgments?q=&division=&year=&act_id=&sec=&judge=` | Case-law search (hybrid, same engine as §7.1, case-law arm only) | any |
| GET | ✱ `/judgments/{judgment_id}` | Metadata, full text by paragraph, linked sections, presigned link to the original PDF | any |
| GET / POST | ✱ `/cases` | List (with `updated_since` cursor) / create | any |
| GET / PATCH / DELETE | `/cases/{id}` | Detail, edit (needs `If-Match`), delete | owner |
| GET | `/cases/{id}/conversation` | The case's conversation (creates it if missing) | LAWYER, JUDGE |
| POST | `/cases/{id}/documents/upload-url` | Presigned S3 PUT URL for direct upload | owner |
| POST | ✱ `/cases/{id}/documents/scan` | Register the upload and start the pipeline → `202 {artifact_id}` | owner |
| GET | `/cases/{id}/artifacts` | List artifacts (`updated_since` cursor) | owner |
| GET / PATCH / DELETE | `/cases/{id}/artifacts/{art_id}` | Status/detail · edit fields or draft HTML (needs `If-Match`) · delete | owner |
| GET | `/cases/{id}/artifacts/{art_id}/events` (SSE) | Live processing status | owner |
| POST | `/cases/{id}/artifacts/{art_id}/reanalyze` | Re-run Schedule II + analysis after the user corrects fields | owner |
| POST | `/cases/{id}/drafts` | Create a draft from a template | LAWYER, JUDGE |
| POST | ✱ `/voice/transcribe-query` | Push-to-talk audio → normalized text | any |
| WSS | ✱ `/voice/stream-dictation` | Live dictation | LAWYER, JUDGE |
| POST | ✱ `/cases/{id}/artifacts/{art_id}/export` | `{format: DOCX|PDF}` → `{download_url}` | owner |
| GET | `/gd-templates` · POST `/gd-drafts` | GD voice-form templates and saving | CITIZEN |
| GET / POST | `/admin/credentials`, `/admin/sync-runs`, `/admin/schedule` | Admin console | ADMIN |

### 5.2 `POST /assistant/query` (SSE)

Request:
```json
{
  "conversation_id": "0193…",          // optional; omit to start a new general conversation
  "query": "চেক ডিসঅনারের শাস্তি কী?",
  "input_mode": "TEXT",                // TEXT | VOICE
  "language": "BN",                    // output language
  "attached_artifact_id": null
}
```

Rules:
- Omitting `conversation_id` creates a general conversation. A case conversation can only be addressed through its own ID.
- A `CITIZEN` sending a case conversation ID gets `404`, which doesn't reveal the case exists.
- `law_as_of_date` is never accepted from the client. It comes from the case's `alleged_offense_date`, only for LAWYER/JUDGE case conversations.

SSE event stream (`text/event-stream`, written with `reply.raw` and flushed per event):
```text
event: meta        data: {"message_id":"…","conversation_id":"…","law_as_of_date":null}
event: token       data: {"t":"চেক ডিসঅনারের "}
event: citation    data: {"ref":1,"kind":"SECTION","section_id":"…","act_id":123,"sec":"138","label":"Section 138, Negotiable Instruments Act, 1881"}
event: token       data: {"t":"[1] অনুযায়ী …"}
event: citation    data: {"ref":2,"kind":"JUDGMENT","judgment_id":"…","para":"74","label":"Md. Humayun Kabir Vs. The State, 20 SCOB [2025] AD, para 74"}
event: done        data: {"status":"COMPLETE","usage":{"input_tokens":…,"output_tokens":…}}
event: error       data: {"code":"UPSTREAM_TIMEOUT","retryable":true}
```

Citations are sent as separate `citation` events only **after** server-side validation (§7.4). Text tokens contain only `[n]` markers. If the client disconnects, the request's `AbortSignal` is passed to `streamText`, which cancels the upstream call, and the message is saved as `INTERRUPTED`.

### 5.3 Dictation WebSocket Protocol

`wss://api…/api/v1/voice/stream-dictation` (`@fastify/websocket`)
- **Auth:** the first frame MUST be `{"type":"auth","token":"<access JWT>","artifact_id":"…","language":"bn-BD"}`. Tokens are never put in query strings, because those end up in access logs. Unauthenticated sockets are closed after 5 s.
- **Audio frames:** binary, **16 kHz mono 16-bit PCM** in 100 ms frames, or **Opus/WebM** (browser `MediaRecorder`). The format is declared in the auth frame.
- **Server → client JSON:**
```json
{"type":"interim","seg":12,"text":"আসামী পক্ষের জামিন"}
{"type":"final","seg":12,"text":"আসামী পক্ষের জামিনের আবেদন","corrections":[{"from":"e jahar","to":"এজাহার"}]}
{"type":"command","name":"NEW_PARAGRAPH"}
{"type":"error","code":"STT_UNAVAILABLE","retryable":true}
```
- **Control frames:** `{"type":"pause"}`, `{"type":"resume"}`, `{"type":"stop"}`.
- **Limits:** a session is capped at 60 minutes (the client opens a new one transparently), the server sends pings every 15 s, and the user may have at most 2 concurrent sessions (counted in Redis).
- **Persistence:** final segments are appended to the draft by the **client** editor, which saves through `PATCH /artifacts/{id}`. The server also keeps a transcript log and the raw audio in S3 for recovery.

### 5.4 Sync & Concurrency

- Every mutable resource returns an `ETag: "<version>"`. `PATCH` MUST send `If-Match`.
- **Implementation:** `UPDATE … SET …, version = version + 1 WHERE id = ? AND owner_user_id = ? AND version = ?`. If the affected-row count is 0, the version didn't match.
- **Version mismatch on a draft:** the server applies *last-write-wins with a preserved copy*. In one transaction it copies the current server version into `artifact_revisions` and then applies the incoming edit. It returns `200` with header `X-Conflict-Preserved: <revision_id>`, and the client shows "An earlier version from another device was saved."
- **Version mismatch on metadata** (case details, extracted fields): `409`. The client reloads and reapplies the change.
- **List endpoints** accept `updated_since=<ISO ts>` for incremental sync and include soft-deleted items as tombstones.

### 5.5 Rate Limits (`@fastify/rate-limit` with the Redis store, per user)

| Endpoint group | Limit |
| :--- | :--- |
| `/auth/otp/request` | 3 / 10 min per identifier, 10 / hour per IP |
| `/assistant/query` | 30 / 10 min (Citizen), 60 / 10 min (Lawyer/Judge) |
| `/documents/scan` | 30 / hour |
| `/voice/transcribe-query` | 60 / 10 min |
| `/judgments` search | 60 / 10 min |
| Dictation | 2 concurrent sessions, 6 h of audio / day |

---

## 6. Module A — Scraper & Temporal Version Engine

### 6.1 Crawl
- **Schedule:** a BullMQ repeatable job (cron `0 2 * * *`, `Asia/Dhaka`) runs the nightly crawl. Changes are detected per Act, and a full re-crawl runs weekly.
- **HTTP client:** `undici` with `p-limit` / BullMQ limiter set to **1 request/second globally**. It honors `robots.txt` (`robots-parser`), identifies with a generic product User-Agent, uses conditional GET (`If-Modified-Since` / `ETag`) where supported, and backs off exponentially on 5xx or timeouts.
- **Discovery:** parse the index pages (`laws-of-bangladesh.html`, alphabetical/chronological lists) to collect `bdlaws_act_id`s, then fetch each Act's consolidated/print view. Confirm the exact URL patterns in a Phase-1 spike and keep them in config, not in code.
- **Snapshotting:** store each fetched HTML page gzip-compressed in S3 (`raw/bdlaws/{act_id}/{fetched_at}.html.gz`). Parsing is then reproducible, and the snapshots serve as an audit trail.

### 6.2 Parse & Normalize (`packages/legal-text`)
1. Parse the HTML with **`cheerio`** into **Act → Part/Chapter → Section → Sub-section → Proviso/Explanation → Footnotes**.
2. **Normalize for hashing:** `String.prototype.normalize('NFC')`, collapse whitespace, unify Bangla variants (e.g. `য়` composed vs decomposed, `ৎ`), strip footnote reference markers from the body text, and convert Bangla digits for the section key only (`৪২০` → `420`). The display text stays verbatim.
3. **Hash:** `crypto.createHash('sha256')` over `normalizedHeading + "\n" + normalizedBody`. Footnotes are hashed separately, so a footnote-only change creates a new version tagged `footnote_only=true`.
4. **Parse footnotes:** rules extract `{action: SUBSTITUTED|INSERTED|OMITTED, by_act: "Act No. … of 2023", section_ref, date?}`.

### 6.3 Versioning Transaction (per section, single MySQL transaction, `REPEATABLE READ`)

```text
current = SELECT … FROM statute_sections
          WHERE statute_id=? AND normalized_section_key=? AND is_current=1 FOR UPDATE
if current is None:                      -> INSERT v1 (valid_from = enactment date, source=ENACTMENT_DATE)
                                            INSERT outbox_events(SECTION_VERSION_CREATED)
elif current.content_hash == new_hash:   -> UPDATE statutes.last_synced_at only
else:
    eff = amendment date parsed from the new footnote, else today (source=DETECTED_ON_SYNC)
    UPDATE current SET is_current=0, valid_to=eff          -- current_key becomes NULL
    INSERT new (version=current.version+1, is_current=1, valid_from=eff, …)
    INSERT outbox_events(SECTION_VERSION_CLOSED: current), (SECTION_VERSION_CREATED: new)
    INSERT outbox_events(NOTIFY_AFFECTED_CASES: section)   # App Flow §15.1
COMMIT
```

- The `current_key` UNIQUE index (§4.2) makes a second "current" row impossible, even under concurrent workers.
- **Sections removed from the portal** are marked superseded (`valid_to` set) and never deleted.
- **Repealed Acts:** `statutes.status = REPEALED`, and the change propagates to Qdrant `act_status`. Their sections stay in place for historical queries, and retrieval excludes them from current-law answers.
- **Safety valve:** if one run changes more than 20% of an Act's sections, which usually means the layout changed, the run is quarantined. Nothing is committed and an admin is alerted.

### 6.4 Embedding Job
The `outbox` worker chunks each new section version (§4.2) and calls TEI `/embed` with `bge-m3` (batch 64). It then upserts the points into Qdrant and sets `section_chunks.indexed_at`. For a closed version it updates the Qdrant payload (`is_current=false`, `valid_to`). The initial embedding of all ~1,480 Acts runs as a one-off backfill job; afterwards only changed sections are embedded.

### 6.5 CrPC Schedule II Table
- **Source:** CrPC 1898 Schedule II, plus schedules of special laws in Phase 1 scope (Nari-O-Shishu Nirjatan Daman Ain, Cyber/Digital security law, NI Act s.138, Narcotics Control Act).
- **Population:** semi-automatic extraction, then **manual verification by a practicing lawyer**, recorded in `verified_by` / `verified_at`. **No row goes live unverified.**
- **Changes:** made only through the Admin Console. Every change is logged in `audit_log`, and the ingest worker's DB user has no write access to this table.

---

## 6A. Module D — Supreme Court Judgment (SCOB) Harvester

Source: Supreme Court Online Bulletin, `https://www.supremecourt.gov.bd/web/?page=bulletin.php&menu=10&lang=`. URL patterns and list fields are in SRS §4.4. Code lives in `apps/worker/src/scob`, beside `src/scrape`, and reuses its HTTP client, limiter, robots handling and snapshot store.

### 6A.1 Crawl
- **Schedule:** BullMQ repeatable job, weekly (cron `0 4 * * 6`, `Asia/Dhaka`). SCOB adds about one issue a year, so a nightly crawl is not needed. A manual `--scob-backfill` CLI command runs the first full load.
- **HTTP:** the same `undici` client as §6.1 with its own **1 request/second limiter for this host** (the bdlaws limiter is unchanged), `robots.txt` honoured, generic product User-Agent, conditional GET, exponential backoff. As in §6.1, the crawler refuses to run if `robots.txt` cannot be fetched.
- **Discovery:** parse the index page for issue links → for each issue, the AD (`div_id=1`) and HCD (`div_id=2`) list pages. Both list templates (per-issue `bulletin_list_{AD|HD}_{n}.php` for newer issues and the generic `bulletin_list.php` for issues 1–14) are recognised. URL patterns and selectors are config (`scob-source-config.ts`), not code, and are confirmed in the JUD-01 spike.
- **Snapshots:** list pages gzip-compressed to S3 (`raw/scob/lists/{issue}/{division}/{fetched_at}.html.gz`); PDFs to `raw/scob/{issue}/{division}/{serial}/{pdf_sha256}.pdf`.

### 6A.2 List Parsing
`cheerio` parses each list row into `{serial, parties, authoring_judge, citation, key_words, summary, key_ratio_paragraphs[], pdf_href}`. Text is stored exactly as published (NFC only). The PDF href is resolved against the page URL and URL-encoded. A row without a PDF link is recorded as a `scrape_events` warning and skipped.

### 6A.3 PDF Processing (BullMQ `scob` queue, one job per judgment)
| Step | Implementation |
| :--- | :--- |
| **1. Fetch & hash** | Download the PDF, check the magic bytes and size limit (50 MB), `sha256` of the bytes. Same hash as the stored row → stop |
| **2. Sanitize** | `qpdf` removes JavaScript and embedded files (as §12.6) |
| **3. Text** | `pdftotext -layout`. Bijoy detection + converter as §8.2 stage 2. If under 200 characters per page on average, treat the page as scanned → `OcrProvider` (needs BE-20); until OCR is available the judgment is set to `NEEDS_REVIEW` |
| **4. Paragraphs** | Detect numbered paragraphs (`^\s*\d+\.` and Bangla digit equivalents) and store them as `[para n]` markers in `full_text` |
| **5. Metadata** | Rules first: case number (`(Civil\|Criminal) (Appeal\|Petition…) No\. … of \d{4}`, Bangla equivalents), decision date (the "Judgment on" / "রায় প্রদানের তারিখ" line), bench (judge names before "J." / "C.J."). Fields the rules miss go to `generateObject` with a small Zod schema; an LLM value is kept **only if it appears verbatim in the text** (`decision_date_source = PDF_LLM`). Public data only, so this is allowed through the relay |
| **6. Statute links** | The §8.4 section detector + Act dictionary run over `key_words` and the body. Resolved pairs go to `judgment_statute_refs` with `statute_id`; anything else is kept with `statute_id = NULL` |
| **7. Write** | One MySQL transaction: upsert `judgments` (old text → `judgment_revisions` if the hash changed), replace `judgment_statute_refs`, write outbox `JUDGMENT_UPSERTED` |

Logs carry IDs, counts and timings only; judgment text is public, but the general rule of no document text in logs still applies.

### 6A.4 Chunking & Indexing
The outbox worker chunks `full_text` on paragraph boundaries (350–500 tokens, the same estimator as §6.4). Each chunk is prefixed with `"{parties}, {citation} ({division}) — para {from}–{to}"`. The key-ratio paragraph(s) always start a new chunk, so they are retrievable on their own. Embedding: TEI `bge-m3`, upsert into `judgment_chunks` (§4.4).

### 6A.5 Linking to Versioned Law
A judgment interprets a section as it stood on the `decision_date`. For each `judgment_statute_refs` row, the API compares the decision date with the `valid_from` of the section's **current** version. If the current version started later, the judgment is returned with `older_than_current_version = true` and the UI shows "Decided before this section was amended on …" (SRS FR-D6).

### 6A.6 Admin
The sync dashboard (App Flow §15.2) also shows SCOB runs: issues found, judgments new/changed/failed, and the `NEEDS_REVIEW` queue, where an admin can enter a missing decision date or case number (`decision_date_source = MANUAL`, logged in `audit_log`).

---

## 7. Module — Citation-Backed RAG Assistant

### 7.1 Pipeline

```text
query ─┬─> [1] Normalize (NFC, Bangla digits, abbreviation expansion: "CrPC" ↔ "ফৌজদারি কার্যবিধি")
       ├─> [2] Explicit-citation detector  (regex: "section 420", "ধারা ৪২০", "s.561A CrPC")
       │        └─ exact hits are pinned into the context (bypass ranking)
       ├─> [3] Hybrid retrieval, both arms in parallel, same as-of filter
       │        • dense:  TEI embed query → Qdrant top-40 (payload filter)
       │        • sparse: MySQL MATCH(...) AGAINST(... IN NATURAL LANGUAGE MODE) top-40
       │        • fuse in Node with Reciprocal Rank Fusion (k=60)
       ├─> [4] Rerank top-40 → top-8 via TEI /rerank (bge-reranker-v2-m3)
       ├─> [5] Sufficiency gate: best rerank score < τ (calibrated on eval set) → NO_PROVISION path
       ├─> [5a] Case-law arm (Module D, runs in parallel with [3]–[4]):
       │        Qdrant judgment_chunks top-20, boosted when statute_ids/section_keys match the
       │        top statute hits → rerank → up to 3 judgment chunks above τ_j
       ├─> [6] Hydrate the 8 chunks' sections + the judgment chunks from MySQL by ID (source of truth)
       ├─> [7] Prompt assembly (role system prompt + numbered SOURCES, statutes first, then
       │        JUDGMENT sources + conversation history)
       ├─> [8] Claude streaming generation (AI SDK streamText)
       └─> [9] Streaming citation validator → SSE to client
```

**Point-in-time filter.**

Qdrant (dense arm):
```jsonc
// current law
{ "must": [ { "key": "is_current", "match": { "value": true } },
            { "key": "act_status", "match": { "value": "ACTIVE" } } ] }
// as-of law (LAWYER/JUDGE case conversation, alleged_offense_date = d)
{ "must": [ { "key": "valid_from", "range": { "lte": "<d>T00:00:00Z" } },
            { "key": "valid_to",   "range": { "gt":  "<d>T00:00:00Z" } } ] }
```

MySQL (sparse arm):
```sql
-- current law
WHERE s.is_current = 1
-- as-of law
WHERE s.valid_from <= :d AND (s.valid_to IS NULL OR s.valid_to > :d)
```

**Case-law arm rules.** The sufficiency gate in [5] looks only at the statute arm: judgments add to an answer but never rescue a NO_PROVISION. Judgment chunks don't take part in the point-in-time filter. Instead, a judgment whose decision date is before the as-of (or current) version of a linked section is marked in its SOURCES block (`decided_on_earlier_version: true`), and the prompt tells the model to say so. The case-law arm runs in parallel and must stay inside the §11.1 retrieval and rerank budgets (to be measured in JUD-07); if it doesn't, the answer is generated from statute sources only and the matched judgments are shown as a "Related judgments" list under the answer (no inline citations).

### 7.2 Conversation Context Isolation (App Flow §5.2)
The context builder loads history **only** through `scoped(db, userId).messages.byConversation(conversationId)`. For a case conversation it also adds:
- the case's `structured_analysis` (from its FIR scans), as compact JSON
- a short summary of drafts (titles plus their first 500 characters)
- `alleged_offense_date`

Nothing from other conversations or cases is ever queried. This is enforced by an integration test that seeds two cases and asserts no cross-reference.

History over ~30k tokens is summarized by a background job into `conversations.summary`, which replaces the older turns in the prompt.

### 7.3 Role Prompt Router
Three frozen system prompts (`CITIZEN`, `LAWYER`, `JUDGE`) live in versioned files (`packages/prompts/assistant/{role}.v{n}.md`). Shared rules in all three:
- Answer **only** from the SOURCES block, and cite every legal claim as `[n]`, where `n` is a source number.
- If the sources don't answer the question, say so explicitly. Never draw on outside legal knowledge.
- Never state bail, cognizance or compoundability status unless it appears in a provided `SCHEDULE_II` source row.
- Cite a judgment only from a `JUDGMENT` source, name the division, and state its holding only as far as the cited paragraph supports it. A legal rule is always cited to the statute too; a judgment never stands alone as the authority for what the law says. Never name a case that is not in SOURCES.
- Respond in `{language}`, and quote statutory text in its original language.
- `LAWYER`: an analytical, adversarial framing is allowed. `JUDGE`: neutral, bench-memo structure, no advocacy. `CITIZEN`: plain language and practical steps, plus a disclaimer that this is not legal representation.

### 7.4 Citation Validation (G1)
- Each source block passed to the model carries a server-side mapping `n → {kind: SECTION, section_id}` or `n → {kind: JUDGMENT, judgment_id, paragraph}`. `messages.citations` stores the same shape.
- The validator is a `TransformStream` over the AI SDK `textStream`. It buffers characters from `[` until `]` before emitting text:
  - `[n]` with `n` in the mapping → emit the token and a `citation` event (sent once per `n`).
  - `n` not in the mapping → drop the marker, add `INVALID_CITATION_STRIPPED` to `messages.flags`, and increment a metric.
- **After generation:** if the answer contains legal assertions but zero valid citations (a heuristic plus a sampled LLM check), the message is flagged for admin review. An answer that cites judgments but no statute section is flagged `JUDGMENT_ONLY_CITATION`. Case names or SCOB-style citations in the text that don't match a source (regex on `Vs.` / `SCOB`) are flagged `UNSOURCED_CASE_REFERENCE`.
- **NO_PROVISION path:** when the sufficiency gate trips, the server streams a fixed, localized message and skips generation entirely. This is deterministic and saves cost.

### 7.5 Cross-Lingual Behavior
`bge-m3` embeds Bangla and English into a shared space. The reranker is multilingual. The prompt tells the model to explain in the user's language and quote the source in its original language. MySQL's ngram FULLTEXT index covers only same-language keyword matches. Cross-lingual recall comes from the dense arm, and it is tracked separately in evals (§14).

### 7.6 AI Provider Integration (Vercel AI SDK → Anthropic via custom base URL)

The project's provider configuration (Anthropic provider, `@ai-sdk/anthropic`, custom `baseURL`) translates to this backend code:

```ts
// packages/providers/src/llm/anthropic.ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { env } from '@lawassist/config';           // zod-validated process.env

export const anthropic = createAnthropic({
  baseURL: env.ANTHROPIC_BASE_URL,                 // e.g. https://api.mwapi.dev/v1 (relay)
  apiKey:  env.ANTHROPIC_API_KEY,                  // from AWS Secrets Manager — never in code or git
});

export const models = {
  assistant:  anthropic(env.LLM_MODEL_ASSISTANT),  // default 'claude-opus-5-5'
  extraction: anthropic(env.LLM_MODEL_EXTRACTION), // default 'claude-opus-5-5'
};
```

```ts
// assistant streaming (simplified)
const result = streamText({
  model: models.assistant,
  system: rolePrompt,                // frozen per role → cacheable prefix
  messages: [...history, { role: 'user', content: withSources(query, sources) }],
  abortSignal: request.signal,
  maxRetries: 2,
  providerOptions: { anthropic: { /* cacheControl / thinking / effort — see table */ } },
});
for await (const chunk of result.textStream.pipeThrough(citationValidator(sourceMap))) { /* SSE */ }
```

```ts
// FIR extraction (structured output validated by Zod)
const { object } = await generateObject({
  model: models.extraction,
  schema: FirExtractionSchema,       // packages/contracts
  system: extractionPrompt,
  prompt: ocrText,
});
```

| Concern | Specification |
| :--- | :--- |
| **Packages** | `ai`, `@ai-sdk/anthropic`, pinned to exact versions. Upgrades go through the eval gate (§14.2) |
| **Endpoint & secrets** | `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` are environment variables, injected from **AWS Secrets Manager** into ECS tasks. Never commit them, print them, or put them in client bundles. There is a separate key per environment (dev/staging/prod), and keys are rotated quarterly or immediately if exposed |
| **Model** | `claude-opus-5-5` for every route (assistant, extraction, ingredient audit, charge matrix, summaries). Model IDs live in config. 🔶 Confirm the relay accepts Anthropic model IDs unchanged |
| **Thinking / effort** | Opus 5.5 always uses adaptive thinking (it can't be disabled). Set effort per route: `low` for Citizen chat and summaries, `medium` for Lawyer/Judge chat and extraction, `high` for the ingredient audit and charge matrix. Pass these through `providerOptions.anthropic`, using the option names supported by the pinned `@ai-sdk/anthropic` version. Verify in Phase 2 that the relay forwards them |
| **Structured outputs** | `generateObject` + Zod schemas. Every result is re-validated server-side. No assistant prefill |
| **Prompt caching** | Each role's system prompt is the stable prefix, marked with Anthropic `cacheControl: { type: 'ephemeral' }` via provider options. Sources, date and query come after it. Check cache-read token counts in `providerMetadata` to confirm the relay passes caching through |
| **Refusals** | Check `finishReason` and provider metadata. A refusal becomes a localized "Couldn't answer this — please rephrase" (`messages.status = ERROR`). Server-side fallback models depend on relay support (🔶 verify) |
| **Timeouts / retries** | 60 s timeout for chat via `AbortSignal.timeout`, plus the AI SDK `maxRetries: 2`. Retry 429 / 5xx / network errors with jitter; never retry 4xx validation errors |
| **Relay health** | A circuit breaker (`opossum`) trips after 5 consecutive upstream failures. While it is open, the assistant returns `error: UPSTREAM_UNAVAILABLE` immediately, and an alert fires |
| **Data minimization** | Send only what's needed: sources, query, and case JSON for case conversations. Never send document images when OCR text is enough. Strip phone numbers and NID numbers from OCR text before LLM calls unless the analysis needs them |
| **Abstraction** | All calls go through `LlmProvider`, so switching to Anthropic's direct endpoint is a configuration change: unset `ANTHROPIC_BASE_URL` |

> ⚠ **Relay = additional data processor.** With a custom `baseURL`, every prompt (user questions, FIR text, case details) goes to the relay operator **before** Anthropic. Before production use with real case data, the relay MUST be covered by the same contractual requirements as other processors (§12.4): no training, no retention beyond processing, a security posture review and a DPA. If those can't be obtained, production MUST use Anthropic's direct API endpoint, and the relay is limited to development with synthetic data. 🔶 Decision D10.

---

## 8. Module B — FIR & Document Scan Pipeline

### 8.1 Upload Path
1. The client calls `POST /cases/{id}/documents/upload-url` and receives a presigned S3 PUT URL (`@aws-sdk/s3-request-presigner`): 10 min TTL, content-type and max size (25 MB) enforced, key `tenants/{user_id}/cases/{case_id}/{artifact_id}/original.{ext}`.
2. The client uploads directly to S3. The mobile app sends the scanner's output as one multi-page PDF or as JPEG pages at most 2000 px on the long edge.
3. The client calls `POST …/documents/scan` with `{s3_key, artifact_type, page_count}`. The API verifies the object with `HeadObject`, then adds a **BullMQ flow** `scan_pipeline(artifact_id, owner_user_id)` and returns `202`.
4. Progress reaches clients through `GET …/artifacts/{id}/events` (SSE, backed by Redis pub/sub). If the mobile app is in the background, a push notification (`firebase-admin` FCM, APNs via FCM) is sent when processing reaches READY or FAILED.

### 8.2 Pipeline Stages (BullMQ flow on the `ocr` → `analysis` queues)

| Stage | Implementation | Output |
| :--- | :--- | :--- |
| **1. Pre-process** | Mobile captures are already cropped and deskewed on-device. For web uploads: PDFs with a text layer (`pdftotext`) skip OCR; scanned PDFs are rasterized at 300 DPI (`pdftoppm`); `sharp` normalizes and applies CLAHE. Rotation and skew are handled by the OCR provider | Clean page images |
| **2. Text extraction** | **Text-layer PDF/DOCX** (`pdftotext` / `mammoth`): detect legacy Bijoy (font names like `SutonnyMJ` or the ANSI byte-range heuristic), then convert Bijoy → Unicode with the `legal-text` mapping-table converter. **Images:** `OcrProvider.read(pages, { hints: ['bn','en'] })` | `raw_extracted_text` + `ocr_confidence` |
| **3. Entity extraction** | `generateObject` with `FirExtractionSchema` (§8.3) | Structured FIR fields |
| **4. Deterministic post-processing** | Parse Bangla/English dates (`date-fns` + a custom Bangla month/digit parser) in `Asia/Dhaka` · compute `filing_delay_minutes` · run the **section detector** (§8.4) and merge with the LLM output (a section found only by the LLM is kept only if it also appears in the text) | Validated entities |
| **5. Schedule II join** | SQL join on `(statute_id, section_number)` with the `effective_from/to` window covering the occurrence date | `structured_analysis.sections[]` with tags; unmatched → `NOT_IN_VERIFIED_SCHEDULE` |
| **6. Role analysis** | `generateObject` with a role-specific Zod schema: Citizen explanation · Lawyer ingredient & loophole audit · Judge charge-framing matrix. Statutory ingredients come from retrieved section text, pinned as sources and validated like §7.4 | `role_analysis` JSON |

**Status updates** are published after each stage. Stages 1–5 are the **"full breakdown"** measured against the 6 s SLA. Stage 6 streams in afterwards, which the UI shows as "Preparing analysis…".

**Failures:** BullMQ retries each stage up to 3 times with exponential backoff on transient errors. A permanent failure sets `FAILED` and stores `processing_error`. OCR confidence below 0.75 sets a `low_confidence` flag.

### 8.3 FIR Extraction Schema (Zod, abridged)

```ts
export const FirExtractionSchema = z.object({
  police_station: z.string().nullable(),  district: z.string().nullable(),
  fir_number: z.string().nullable(),      gr_number: z.string().nullable(),
  occurrence_datetime: z.string().nullable(),   // raw string; parsed deterministically in stage 4
  reported_datetime: z.string().nullable(),
  informant: z.object({ name: z.string(), address: z.string().nullable() }),
  accused: z.array(z.object({ name: z.string(), role_in_allegation: z.string().nullable() })),
  witnesses: z.array(z.object({ name: z.string() })),
  cited_sections: z.array(z.object({ act_hint: z.string().nullable(), section: z.string(), raw: z.string() })),
  narrative_summary: z.string(),
  field_confidence: z.record(z.enum(['HIGH', 'MEDIUM', 'LOW'])),
});
```

### 8.4 Section Detector (deterministic, `packages/legal-text`)
- **Patterns:** `ধারা|section|sec\.?|s\.|u/s` followed by a number list such as `৩০২/৩৪`, `420/406`, `302, 34`, `৫৬১ক` / `561A`.
- **Digit and letter mapping:** Bangla → ASCII digits, `ক→A`, `খ→B`, and so on for sub-lettered sections.
- **Act resolution:** use an act named near the citation (dictionary of Act names and abbreviations in BN/EN, e.g. `দণ্ডবিধি`, `PC`, `নারী ও শিশু`). If none is named, default to the Penal Code for FIR documents, flagged `act_inferred=true` so the UI can show it.
- **Combined citations:** `302/34` expands to two rows and keeps the combination as `cited_together` for the analysis.

### 8.5 Field Corrections
`PATCH /artifacts/{id}` with edited `structured_analysis` fields → records the edit in `audit_log` → `POST /reanalyze` re-runs stages 4–6 only.

---

## 9. Module C — Voice

### 9.1 Push-to-Talk Query (`POST /voice/transcribe-query`)
- **Input:** `@fastify/multipart` audio (≤ 60 s; `audio/webm;codecs=opus`, `audio/mp4`, `audio/wav`).
- **Processing:** transcode to 16 kHz mono with `ffmpeg` (bundled in the image, spawned as a child process) if needed → `SttProvider.recognize({ lang: 'bn-BD', alt: ['en-US'], phraseSet: 'legal_glossary' })` → glossary post-processor → response `{text, confidence}`.
- **Storage:** query audio is **not stored by default** (privacy). It is kept for 7 days only if the user opts in (🔶 D6).

### 9.2 Live Dictation
```text
client mic ─WS─> api (dictation handler) ─gRPC stream─> Google STT v2 (interim results on)
                       │                                       │
                       │<──── interim / final results ─────────┘
                       ├─ final → GlossaryCorrector → command parser → WS "final"/"command"
                       └─ tee raw audio → S3 multipart upload (@aws-sdk/lib-storage)
```
- **Sticky routing:** the ALB keeps the WebSocket on one API task, and each task handles up to 200 concurrent sessions. Node handles these as async I/O. CPU-heavy glossary matching is kept to O(tokens) with a precomputed trie.
- **Stream limits:** if Google's per-stream limit is reached, the handler rotates to a new STT stream seamlessly, carrying 1 s of overlap and de-duplicating at the boundary.
- **Corrections apply to `final` segments only.** Interim results are shown raw, which keeps the hot path under 800 ms.

### 9.3 Legal Glossary Post-Processor (FR-C3)
- **Glossary store:** a versioned YAML (`packages/legal-text/glossary/legal_bn_en.v{n}.yaml`). Each entry has: canonical form, Bangla/English variants, romanized phonetic variants, and a context tag (criminal, civil, revenue).
- **Two uses:**
  1. Pushed to the STT engine as **phrase-set boosts**, which prevents errors up front.
  2. **Post-correction:** token n-gram matching against the variants (normalized edit distance ≤ 0.2 via `fastest-levenshtein`, plus a Bangla phonetic key) → replaced with the canonical form. Every replacement is reported in `corrections[]`, so the editor can underline it and the user can undo it.
- **Numbers:** spoken section references are converted to citation format, e.g. "ধারা চারশো বিশ" → `ধারা ৪২০` and "section five sixty one A" → `Section 561A`.
- **Spoken commands** (exact match on a final segment, BN/EN): new paragraph, full stop / দাঁড়ি, comma, undo last sentence.
- **No LLM on the hot path.** An optional "Polish paragraph" button calls the LLM on demand.

### 9.4 GD Voice-Fill (Citizen)
Each template is a Zod/JSON schema of prompts and fields. Each field answer goes through `/voice/transcribe-query`, then field-type parsing (date, phone, name). The result is rendered to `editable_document_html` as a `GD_DRAFT` artifact.

---

## 10. Export Service

- `POST …/export` adds a job to the BullMQ `export` queue. The API waits up to 10 s (`job.waitUntilFinished`) and then returns `202` with a job ID if the export isn't ready.
- **DOCX:** TipTap JSON/HTML → `docx` npm builder with court styles (A4, margins, Bangla font `Noto Serif Bengali` / fallback `SolaimanLipi`, 1.5 line spacing). Citations can optionally become footnotes.
- **PDF:** HTML + print CSS → **Playwright Chromium `page.pdf()`** in the export worker. The browser is reused with one context per job, and the fonts are installed in the image. A test suite compares renders of known Bangla conjunct words against reference images.
- **Output:** stored at `tenants/{user}/exports/{uuid}.{ext}` with a 24 h S3 lifecycle rule and returned as a presigned GET URL (5 min TTL).

---

## 11. Performance Engineering

### 11.1 Latency Budgets (p90)

**Q&A first token ≤ 1.5 s**
| Step | Budget |
| :--- | :--- |
| Auth + load conversation + rate limit | 40 ms |
| Query embedding (TEI, GPU) | 40 ms |
| Hybrid retrieval: Qdrant + MySQL FULLTEXT in parallel | 80 ms |
| Rerank 40 → 8 (TEI, GPU) | 120 ms |
| Hydrate sections from MySQL + prompt assembly | 30 ms |
| LLM time-to-first-text-token (relay + model, cached prefix, tuned effort) | ≤ 1,090 ms |
| Citation buffer / network | 100 ms |

The relay adds a network hop, so measure its overhead in Phase 2. If the model step can't meet its budget, the levers in order are: lower the effort for that route → shrink the sources (top-8 → top-5) → stream a deterministic "Sources found: …" event immediately → use the direct Anthropic endpoint. Report the trade-offs before changing the model.

**Dictation word ≤ 800 ms:** client buffering 100 ms + network 80 ms + STT interim result ~300–450 ms + relay to client 20 ms.

**FIR full breakdown ≤ 6 s (1 page):** queue pickup 200 ms + OCR 1.5 s + LLM extraction ≤ 3 s + deterministic steps & join 100 ms + status push 100 ms.

### 11.2 Capacity Assumptions (pilot)
| Metric | Pilot (Weeks 10–12) | Design headroom |
| :--- | :--- | :--- |
| Registered users | 500 | 20,000 |
| Peak concurrent Q&A streams | 30 | 500 |
| Concurrent dictation sessions | 15 | 300 |
| Scans / day | 300 | 10,000 |
| Corpus | ~1,480 Acts, ~60k section versions, ~150k chunks | 5× chunks |
| Case law (SCOB) | 20 issues × 2 divisions, roughly 1,000–2,000 judgments, ~50k chunks (estimate; JUD-01 measures it) | Grows by about one issue a year |

**Sizing:**
- **Qdrant:** 150k × 1024-dim float32 ≈ 0.6 GB of vectors plus HNSW overhead, which fits in 2–4 GB RAM. Scalar quantization (int8) is available if needed.
- **MySQL:** `db.r6g.large` is ample for the pilot. The ngram FULLTEXT index on ~60k sections is modest.

### 11.3 Caching
- **Redis cache:** statute section reads, Schedule II strip included (`statutes:v1:section:{act}:{generation}:{sec}:{as_of}`, 1 h TTL). The scraper bumps the Act's generation (`statutes:v1:gen:{act}`) right after each committed sync, so a changed Act is never served from cache; the TTL only bounds staleness if a bump is lost. Not tied to the outbox, because index events complete only after TEI/Qdrant succeed and a TEI outage would otherwise keep stale law text cached. A Redis failure falls back to MySQL.
- **CDN:** caches the public law-library pages (Next.js ISR, revalidated on sync).
- **MySQL pool:** `mysql2` pool of 20 connections per API task. Use RDS Proxy if the task count grows.

---

## 12. Security & Privacy

### 12.1 Authentication
- **OTP:** 6 digits, 5 min TTL, at most 5 attempts, stored as an HMAC hash. SMS goes through a Bangladeshi SMS gateway (🔶 D7) and email through SES.
- **Access JWT:** 15 min, signed with ES256 (`jose`), claims `sub`, `role`, `verification_status`, `jti`.
- **Refresh token:** 30 days, opaque, rotated on every use, with reuse detection that revokes the whole family.
- **Token storage:** mobile uses Keychain/Keystore (`flutter_secure_storage`). Web keeps the access token in memory and the refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth/refresh`.

### 12.2 Authorization
- **Role checks:** a Fastify `preHandler` hook per route (`requireRoles('LAWYER','JUDGE')`), plus `verification_status === 'VERIFIED'` for professional features.
- **Resource ownership:** enforced through scoped repositories, a lint ban on raw access, and the isolation test suite (§4.3).
- **Admin routes:** need a separate `ADMIN` role, MFA (TOTP via `otplib`), and an IP allowlist.

### 12.3 Data Protection
| Data | At Rest | In Transit | Retention |
| :--- | :--- | :--- | :--- |
| MySQL (RDS) | Storage encryption (AES-256, KMS CMK); automated backups encrypted | TLS 1.2+ (`require_secure_transport=ON`) | Until the user deletes it; backups 14 days |
| Qdrant | Encrypted EBS/EFS volume | TLS + API key; private subnet only | Public statute and judgment data only — **no user data** |
| S3 vault | SSE-KMS; bucket policy denies unencrypted PUT and non-TLS | TLS | Until deleted; exports 24 h; dictation audio 30 days (🔶 D6) |
| Redis | Encryption at rest + in-transit enabled | TLS | Ephemeral |
| Logs | No document text, transcripts or queries. IDs only, with `pino` redaction paths | | 30 days |
| Secrets | AWS Secrets Manager (LLM key, Google service-account key, DB passwords, JWT keys) | — | Rotated quarterly or on exposure |

- **Account deletion:** a hard-delete job removes the user's rows, S3 objects and conversation history within 30 days, and `audit_log` records the deletion.

### 12.4 Third-Party Processors
| Processor | Data Sent | Requirement |
| :--- | :--- | :--- |
| **AI relay** (`ANTHROPIC_BASE_URL` host) | Query text, retrieved statute text, OCR text, case JSON | **DPA, no training, no retention beyond processing, and a security review before any real user data. Otherwise switch to Anthropic direct (D10)** |
| Anthropic (Claude) | Same as above, via the relay | Commercial API terms (not used for model training). Request zero-data-retention if eligible |
| Google Cloud (Vision, STT) | Page images, audio | Data-processing terms with no training use; regional endpoint if available; logging disabled |
| SMS gateway | Phone number, OTP | DPA |

All processors are listed in the privacy notice (App Flow §14).

### 12.5 Compliance
- Confirm obligations under the current Bangladesh personal data protection law and the ICT Act with counsel **before the pilot**: data residency, consent, and breach notification. 🔶 D4: cloud region pending this review.
- Show an in-app disclaimer: the service gives legal information, not legal representation.

### 12.6 Application Security
- **Checks:** OWASP ASVS L2 checklist. CI runs `eslint-plugin-security`, Semgrep, `pnpm audit`, Trivy image scanning and Gitleaks secret scanning (blocks commits containing keys).
- **HTTP hardening:** `@fastify/helmet`, and `@fastify/cors` limited to the web origin.
- **Upload validation:** magic-byte type check (`file-type`), size limit, and PDF sanitization (strip JavaScript and embedded files with `qpdf`) before processing. DOCX parsing runs in a worker with no network egress.
- **Prompt injection:** uploaded documents and retrieved text are passed as data inside delimited blocks, with a system instruction to ignore instructions found inside them. The model has **no tools** in the MVP, so injected text cannot trigger actions.
- **SQL injection:** prevented by Drizzle parameterized queries. Raw SQL is allowed only through tagged `sql` templates, never string concatenation.

---

## 13. Infrastructure & DevOps

### 13.1 Environments
| Env | Purpose | Data |
| :--- | :--- | :--- |
| `local` | docker-compose: api, worker, mysql:8.4, redis, qdrant, SeaweedFS (S3 API; MinIO no longer publishes images), TEI (CPU) | Seed corpus (10 Acts) |
| `staging` | Mirrors production at small scale | Full corpus, synthetic user data only |
| `production` | Pilot | Real data |

### 13.2 Runtime Topology (production)
| Component | Spec (pilot) | Scaling |
| :--- | :--- | :--- |
| `api` (ECS Fargate, Node 22) | 2× (1 vCPU, 2 GB) | CPU 60% / active WS connections |
| `worker-ocr-analysis` | 2× (1 vCPU, 2 GB) | BullMQ queue depth |
| `worker-scrape-embed-export` (with Chromium, Poppler, ffmpeg) | 1× (2 vCPU, 4 GB) | Manual |
| `qdrant` (ECS on EC2 with an EBS volume, or Qdrant Cloud 🔶) | 1× (2 vCPU, 4 GB) + snapshots to S3 | Vertical; replicas later |
| `tei-embed` + `tei-rerank` (EC2 `g5.xlarge` or similar) | 1× | Manual. Backfills run on a spot instance |
| RDS for MySQL 8.4 | `db.r6g.large`, Multi-AZ, point-in-time restore, binlog retention 7 days | Vertical; read replica later |
| ElastiCache Redis | `cache.t4g.small` ×2 (`maxmemory-policy noeviction` for BullMQ) | — |

### 13.3 CI/CD
- **Every PR:** `pnpm lint` (eslint, `tsc --noEmit`, `dart analyze`) → Vitest unit tests → integration tests (Testcontainers: MySQL 8.4, Redis, Qdrant) → Gitleaks / Semgrep / Trivy → Docker builds.
- **`main`:** deploy to staging → run the smoke tests and the **eval gate** (§14.2) → manual approval → production (ECS rolling deploy).
- **Migrations:** `drizzle-kit` generates SQL, which is reviewed and applied by the `app_migrate` user. Use the expand/contract pattern, and run large table changes with `ALGORITHM=INSTANT/INPLACE`, or `gh-ost` if needed.
- **Mobile:** Fastlane → TestFlight / Play internal track. The API keeps backward compatibility for N-1 app versions, and a minimum supported version is sent in `/config`.

### 13.4 Observability
- **Traces:** OpenTelemetry auto-instrumentation (Fastify, `mysql2`, `ioredis`, `undici`), plus manual spans for retrieval, LLM, validator and scan stages. AI SDK telemetry is turned on with `experimental_telemetry` with **inputs/outputs recording disabled** (privacy). Trace IDs are returned in the `X-Request-Id` header.
- **Metrics (Prometheus):**
  - Q&A first-token latency and the NO_PROVISION rate
  - Invalid-citation-stripped count (**alert if > 0.5% of answers**)
  - LLM relay latency, error rate and circuit-breaker state
  - OCR confidence distribution and scan stage durations
  - STT interim latency
  - Outbox lag (oldest unprocessed event)
  - BullMQ queue depth
  - LLM tokens per route
  - Scraper changes per run and quarantines
  - SCOB runs: judgments new/changed/failed, `NEEDS_REVIEW` count, `UNSOURCED_CASE_REFERENCE` / `JUDGMENT_ONLY_CITATION` flags
- **Alerts:** SLA breaches (p90 over target for 15 min), queue depth over 100, outbox lag over 10 min, the relay circuit opening, scraper failure two nights in a row, SCOB crawl failure two weeks in a row, error rate above 2%.

---

## 14. Testing & Quality Strategy

### 14.1 Automated Tests
| Layer | Scope |
| :--- | :--- |
| **Unit (Vitest)** | Normalizer & hashing · Bijoy→Unicode converter · section detector (≥ 300 citation strings: Bangla/English, letters, combinations) · date/delay calculator · glossary corrector · citation validator (streaming edge cases: split brackets, unknown refs) · RRF fusion · SCOB list parser (both templates, fixtures from JUD-01) · judgment paragraph splitter and metadata rules |
| **Integration** | SCOB ingest: new judgment → changed PDF → revision kept, re-indexed; replay idempotent · Versioning transaction (amend → archive → point-in-time read) + `current_key` uniqueness under concurrency · outbox → Qdrant sync and replay idempotency · **tenant isolation suite over every route** (§4.3) · case-conversation isolation (§7.2) · Citizen blocked from case conversations (service + trigger) · optimistic concurrency & revision preservation |
| **Contract** | OpenAPI generated from Zod → typed clients for web (`openapi-typescript`, or the shared `packages/contracts` directly) and mobile (`openapi-generator` dart). CI fails on breaking changes |
| **E2E** | Playwright (web): login → ask → open verifier; upload FIR → result. Flutter `integration_test`: scan → result; push-to-talk |
| **Load** | k6: 50 concurrent SSE streams, 20 dictation sockets, 100 scans/10 min, with SLA assertions |
| **LLM mocking** | Unit and integration tests use the AI SDK's `MockLanguageModelV2` (`ai/test`), so CI never calls the relay |

### 14.2 AI Evaluation Sets (gate releases)
| Eval | Content | Pass Bar (MVP) |
| :--- | :--- | :--- |
| **Legal Q&A golden set** | 300 questions (BN/EN/mixed, all 3 roles) written and answer-keyed by practicing lawyers, each with the expected section(s) | Citation precision ≥ 0.95 · expected-section recall@8 ≥ 0.90 · 0 fabricated citations · correct NO_PROVISION on 30 out-of-scope questions |
| **Cross-lingual retrieval** | 100 Bangla queries whose answer is in English statutes | recall@8 ≥ 0.85 |
| **Point-in-time** | 40 amended sections queried on dates before and after the amendment | 100% correct version |
| **FIR extraction** | 150 real anonymized FIRs (printed and handwritten) | Field F1 ≥ 0.90 printed / ≥ 0.75 handwritten · section detection recall ≥ 0.97 |
| **OCR** | Same set | Character error rate ≤ 5% printed, ≤ 15% handwritten |
| **STT** | 5 h of legal dictation (10+ speakers, code-switched) | WER ≤ 15% · glossary term accuracy ≥ 0.95 |
| **Schedule II** | Every row checked against the source schedule | 100% |
| **Case-law retrieval & citation** | 60 questions where lawyers name the expected judgment(s) and paragraph | Judgment citation precision ≥ 0.95 · expected-judgment recall@3 ≥ 0.80 · 0 fabricated case names or citations · 0 judgment-only answers |
| **Judgment metadata** | 50 judgments sampled across issues and both divisions, checked by hand against the PDF | Citation, division, parties 100% · decision date and case number ≥ 0.95 · statute-link precision ≥ 0.95 |

The eval runner (`evals/`, Node) runs nightly on staging and on every prompt, model, SDK or relay config change, and stores results per run for comparison.

---

## 15. Client Technical Notes

### 15.1 Web (Next.js)
- **Routing:**
  - `/(auth)` login
  - `/chat/[conversationId]`
  - `/cases/[caseId]/(overview|documents|drafts|conversation)`
  - `/library/[actId]/[section]` (public, SSR, SEO)
  - `/library/judgments` and `/library/judgments/[judgmentId]` (public, SSR)
- **Shared types:** imports Zod schemas and types from `packages/contracts`, so the web and API can't drift.
- **SSE:** `fetch` + `ReadableStream` parser, because `EventSource` doesn't support `POST` or custom auth headers. The browser **never** calls the LLM directly, and no AI keys exist in the web bundle.
- **Dictation:** `getUserMedia` → `AudioWorklet` downsampling to 16 kHz PCM → WebSocket. Interim text is rendered as a TipTap decoration and the final text is inserted as a transaction.
- **Verifier panel:** a resizable split view, with deep links via `?verify=act:sec`.
- **i18n:** `next-intl` (BN/EN), Bangla web font `Noto Sans Bengali` (subset, `font-display: swap`).

### 15.2 Mobile (Flutter)
- **Navigation:** `go_router` with the bottom tabs Home · Cases · Scan · Library · Profile (App Flow §2.2).
- **Scanner:** ML Kit Document Scanner (Android) / `VNDocumentCameraViewController` (iOS), which output a multi-page PDF.
- **Push-to-talk:** `record` package (AAC/Opus), upload on release.
- **Dictation:** PCM stream → `web_socket_channel`.
- **Offline queue:** `drift` (SQLite) table of pending uploads and draft edits. Retries use exponential backoff, and the queue is processed on connectivity change.
- **Push notifications:** FCM (APNs via FCM) for scan completion.
- **Security:** certificate pinning for the API domain, screenshot blocking on case screens (Android `FLAG_SECURE`, 🔶 D8), and the local cache encrypted with SQLCipher.

---

## 16. Delivery Mapping to SRS Roadmap

| Phase (SRS §8) | Technical Deliverables from This TRD | Exit Criteria |
| :--- | :--- | :--- |
| **1: Weeks 1–3** | Monorepo, CI, Terraform skeleton · MySQL schema (Drizzle), scoped repos + isolation suite · §6 scraper, normalizer, versioning, outbox · TEI + Qdrant + embedding backfill for the top 50 Acts · Schedule II table + lawyer verification | Point-in-time eval 100% · Schedule II 100% verified · nightly sync green 5 days in a row · outbox lag < 10 min |
| **2: Weeks 4–6** | §5 auth, conversations, cases APIs · §7 RAG pipeline, validator, role prompts · **AI relay integration + relay checks** (model IDs, caching, effort options, latency overhead) · Next.js web: chat, verifier, library, cases · eval runner + Q&A golden set v1 · §6A SCOB harvester, backfill of all issues, statute linking, `judgment_chunks` index | Q&A eval pass bar · first token ≤ 1.5 s p90 on staging · D10 relay decision recorded · all SCOB issues ingested, judgment-metadata eval passed |
| **3: Weeks 7–9** | §8 scan pipeline end to end · §9 transcribe-query + dictation WS + glossary v1 · §10 export · web dictation editor · case-law arm in §7.1, judgment citations, `/judgments` API, web judgment viewer | FIR/OCR/STT eval pass bars · 6 s / 800 ms SLAs on staging · case-law eval pass bar |
| **4: Weeks 10–12** | Flutter app (scanner, push-to-talk, dictation, offline queue, push, case-law viewer) · full ~1,480-Act ingestion · admin console · load tests · security review · pilot onboarding | Load test SLAs · no open high-severity security findings · pilot go-live |

---

## 17. Open Technical Decisions

| # | Decision | Default in This TRD | Alternatives / Note |
| :--- | :--- | :--- | :--- |
| D1 | OCR vendor | Google Cloud Vision | Azure Document Intelligence; Tesseract `ben` (weak on handwriting). Benchmark in Week 6 on the FIR eval set |
| D2 | STT vendor | Google STT v2 streaming | Azure Speech; self-hosted Whisper (struggles to meet 800 ms when streaming). Benchmark in Week 6 |
| D3 | Mobile framework | Flutter | React Native (would share TypeScript with the backend and web) |
| D4 | Cloud region / data residency | AWS `ap-south-1` | A local Bangladeshi data center if legal review requires in-country hosting; the stack is portable (MySQL, S3-compatible, containers) |
| D5 | LLM model per route | `claude-opus-5-5` everywhere, effort tuned per route | A smaller model (e.g. `claude-haiku-5-5`) for extraction or summaries could cut cost. Decide after measuring quality on the eval sets |
| D6 | Voice audio retention | Query audio not stored; dictation audio 30 days | Shorter retention vs. ability to recover failed dictations |
| D7 | SMS OTP vendor | Local BD gateway | International gateway (higher cost, lower deliverability in BD) |
| D8 | Screenshot blocking on case screens | Enabled on Android | May frustrate users who share with clients; confirm with the pilot |
| D9 | Vector store & keyword search | Qdrant + MySQL ngram FULLTEXT | MySQL HeatWave (native vector search, Oracle Cloud only); OpenSearch for both arms if Bangla keyword recall falls short |
| D10 | **AI relay in production** | Relay used only once DPA, no-training and no-retention terms are confirmed | **Anthropic direct API** (`ANTHROPIC_BASE_URL` unset). Required if the relay can't meet §12.4 |
| D11 | Qdrant hosting | Self-hosted on ECS/EC2 | Qdrant Cloud (managed; adds another processor, but it holds public statute and judgment data only) |
| D12 | Case-law scope | **Decided 2026-11-04:** SCOB reported judgments (AD + HCD) only, English/original-language PDFs | Bengali translations, unreported judgments, cause lists, subordinate courts: post-MVP. A paid law-report source would need licensing |
