# bdlaws scraper (TRD §6)

Pipeline: **discover → fetch → snapshot → parse → plan → version**, one Act at a time.

| Step | File | Notes |
| :--- | :--- | :--- |
| URL patterns & selectors | `source-config.ts` | Config, not code. Override with a JSON file via `SCRAPER_SOURCE_CONFIG` |
| HTTP | `http-client.ts`, `rate-limiter.ts` | 1 req/s global, robots.txt, ETag/Last-Modified (Redis), backoff 2s→60s with jitter, Retry-After |
| Discovery | `discover.ts` | Act ids from the index pages' links |
| Snapshots | `snapshot-store.ts` | `raw/bdlaws/{act_id}/{fetched_at}.html.gz` in S3 (SeaweedFS locally) |
| Parse | `parser.ts` | Act → Chapter → Section → Sub-section/Proviso/Explanation/Illustration → Footnotes |
| Footnote rules | `packages/legal-text/src/footnote.ts` | SUBSTITUTED / INSERTED / OMITTED, amending Act, "with effect from" date |
| Versioning | `versioning.ts` | Plan, 20% safety valve, per-section REPEATABLE READ transaction + outbox |
| Run | `run-scrape.ts`, `../main.ts`, `../cli.ts` | `scrape_runs` / `scrape_events`; BullMQ nightly 02:00 and weekly full (Fri 03:00) Asia/Dhaka |

## Running

```bash
docker compose up -d                                     # mysql, redis, qdrant, s3 (SeaweedFS) + bucket
pnpm db:migrate
pnpm --filter @lawassist/worker scrape -- --acts 11,75   # manual run, no queue
pnpm --filter @lawassist/worker scrape -- --act 11 --snapshot raw/bdlaws/11/<ts>.html.gz   # re-sync a stored snapshot
pnpm --filter @lawassist/worker dev                      # worker + job schedulers
```

Add `--full` to skip conditional GET. Add `--force` to commit a quarantined Act after an admin has reviewed it.

## URL patterns (verified 2026-11-04)

| Page | Pattern | Notes |
| :--- | :--- | :--- |
| Act list (discovery) | `/laws-of-bangladesh-chronological-index.html` | ~2.6 MB, links all **1,685** Acts as `/act-{id}.html`; titles carry `[Repealed]` / `[রহিত]` |
| Not used | `/laws-of-bangladesh.html` (links 58 `/volume-{n}.html` pages only) · `/laws-of-bangladesh-alphabetical-index.html` (~57 MB) | |
| Act detail | `/act-{id}.html` | Links `/act-{id}/section-{n}.html`, `/act-{id}/chapter-{n}.html` |
| Print view (parsed) | `/act-print-{id}.html` | Whole Act on one page |
| Link pattern on index pages | `act-(?:details-\|print-)?(\d+)\.html` | |

**Encoding.** Index, volume and detail pages are served as `charset=UTF-16` (big-endian, with a BOM); print views as UTF-8. `http-client.ts` decodes by BOM, then charset, then UTF-8 (`decodeBody`). fetch's `text()` would read UTF-16 as UTF-8 and discovery would find nothing.

**No validators.** Responses carry no `ETag` or `Last-Modified` (Apache, `Cache-Control: public`), so conditional GET never applies and change detection relies on content hashes alone.

**Speed.** Print views: CrPC 41 s, Penal Code 22 s, mid-size Acts 9–14 s, small Acts ~3 s. Index and detail pages < 1 s. Request timeout is 120 s.

## Print-view markup (verified 2026-11-04)

| Element | Selector | Notes |
| :--- | :--- | :--- |
| Title | `.bg-act-section h3` | Contains Act-wide footnote markers; stripped |
| Act no. / date | `.bg-act-section h4, .publish-date` | "( ACT NO. XLV OF 1860 )", "[ 6th October, 1860 ]"; Bangla "( ২০০০ সনের ৮ নং আইন )" |
| Section row | `.lineremoves` | `.lineremove` (singular) is the title block |
| Chapter | `.act-chapter-group` | "Chapter I" + "INTRODUCTION". Sits **inside the row of the chapter's first section** |
| Marginal heading | `.txt-head` | |
| Section text | `.txt-details` | English: paragraphs split by `<div class="clbr">` / `<div class="na">`. Bangla: `<p>` |
| Footnote marker | `sup` | Inside `<span class="footnote" title="…full footnote text…">`; the number is the `<sup>` text |
| Footnote entries | `.footnoteListAll li.footnoteList` | `<h6><sup>n</sup></h6>` then the text |
| Repealed Act | `.repealed, .bn-repealed` on every section row | The title usually does not say so |

**Numbering quirks the parser handles** (all seen in the spike Acts):

| Quirk | Example | Handling |
| :--- | :--- | :--- |
| Two Bangla terminators | `১।` (U+0964) and `১৷` (U+09F7, looks the same) | Both accepted |
| Hyphenated letter I | `171-I.`, `265-I.`, `131-I.` | Key `171I`, not a duplicate of `171` |
| One row, several spent sections | `23 and 24. [Repealed …]`, `100-103. [Omitted …]` | One entry per section, same text |
| Section split over several rows | Evidence Act s.32 `(1)`…`(8)`, CrPC sub-sections, Penal Code exceptions, each row with its own marginal note | Rows without a number join the section above; their notes go into the hash |
| Stray marginal note before the number | NI Act `“Payee”` ⏎ `8. The “holder” …` | Starts section 8 only if the number is later and unseen; the note joins the previous section's notes |
| Preamble / empty rows | `Preamble` row, trailing empty rows | Skipped |

## DATA-01 spike results (2026-11-04)

The portal was reachable again on 2026-11-04 (it was unreachable on 2026-11-03). Spike Acts and parse results, kept as gzip snapshots in `test/fixtures/bdlaws/` and checked in `test/parser.test.ts`:

| Id | Act | Sections | Notes |
| :--- | :--- | ---: | :--- |
| 11 | Penal Code, 1860 | 558 | `171-I`, exceptions split over rows |
| 75 | Code of Criminal Procedure, 1898 | 523 | Heavily amended (223 dated footnotes). Portal defect: s.88 cites footnote 107, which the list lacks |
| 24 | Evidence Act, 1872 | 182 | s.32 split over 8 rows |
| 86 | Code of Civil Procedure, 1908 | 171 | One chapter group ("PRELIMINARY"); its Part titles are `act-section-head` sub-headings (see gap below); `100-103` range |
| 46 | Negotiable Instruments Act, 1881 | 172 | Stray notes, `131-I` |
| 835 | নারী ও শিশু নির্যাতন দমন আইন, ২০০০ | 42 | Bangla, `<p>` paragraphs |
| 1276 | মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮ | 78 | Bangla; both terminators (U+0964 ×98, U+09F7 ×5), as in 835 |
| 1457 | সাইবার নিরাপত্তা আইন, ২০২৩ | 60 | Repealed (`bn-repealed`) |
| 16 | Public Gambling Act, 1867 | 18 | Repealed (`repealed`) |

None of these Bangla Acts has lettered sections (`১১ক`); the synthetic fixture covers that case. Sprint 1 demo run on 2026-11-04 against the live portal, MySQL, Redis and S3: 1,804 sections ingested in 2 min 11 s, re-run 0 changes, edited snapshot → s.420 v2 current and v1 archived.

**Known gap: sub-headings.** `p.act-section-head` sub-headings inside a chapter (Penal Code "Of Hurt", CrPC "A.-Classes of Criminal Courts", CPC Part titles such as "Place of Suing") are not captured. `chapterReference` holds only the chapter group, so every CPC section carries "PRELIMINARY". Not in the content hash, so fixing it later creates no versions.

**Open: nightly crawl cost.** With no validators, the nightly job downloads every Act: about 1,685 × ~12 s ≈ 5–6 h, overlapping Friday's weekly full crawl. Proposal (not implemented): nightly = new Act ids from the chronological index + the Acts amended by them + the top-50 corpus; weekly = full crawl.
