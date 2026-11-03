# bdlaws scraper (TRD §6)

Pipeline: **discover → fetch → snapshot → parse → plan → version**, one Act at a time.

| Step | File | Notes |
| :--- | :--- | :--- |
| URL patterns & selectors | `source-config.ts` | Config, not code. Override with a JSON file via `SCRAPER_SOURCE_CONFIG` |
| HTTP | `http-client.ts`, `rate-limiter.ts` | 1 req/s global, robots.txt, ETag/Last-Modified (Redis), backoff 2s→60s with jitter, Retry-After |
| Discovery | `discover.ts` | Act ids from the index pages' links |
| Snapshots | `snapshot-store.ts` | `raw/bdlaws/{act_id}/{fetched_at}.html.gz` in S3 (MinIO locally) |
| Parse | `parser.ts` | Act → Chapter → Section → Sub-section/Proviso/Explanation/Illustration → Footnotes |
| Footnote rules | `packages/legal-text/src/footnote.ts` | SUBSTITUTED / INSERTED / OMITTED, amending Act, "with effect from" date |
| Versioning | `versioning.ts` | Plan, 20% safety valve, per-section REPEATABLE READ transaction + outbox |
| Run | `run-scrape.ts`, `../main.ts`, `../cli.ts` | `scrape_runs` / `scrape_events`; BullMQ nightly 02:00 and weekly full (Fri 03:00) Asia/Dhaka |

## Running

```bash
docker compose up -d                                     # mysql, redis, minio
pnpm db:migrate
pnpm --filter @lawassist/worker scrape -- --acts 11,75   # manual run, no queue
pnpm --filter @lawassist/worker scrape -- --act 11 --snapshot raw/bdlaws/11/<ts>.html.gz   # re-sync a stored snapshot
pnpm --filter @lawassist/worker dev                      # worker + job schedulers
```

Add `--full` to skip conditional GET. Add `--force` to commit a quarantined Act after an admin has reviewed it.

## URL patterns (to be confirmed by the spike)

| Page | Pattern |
| :--- | :--- |
| Index | `/laws-of-bangladesh.html`, `/laws-of-bangladesh-alphabetical-index.html`, `/laws-of-bangladesh-chronological-index.html` |
| Act detail | `/act-{id}.html` |
| Print view (parsed) | `/act-print-{id}.html` |
| Link pattern on index pages | `act-(?:details-\|print-)?(\d+)\.html` |

## Assumed print-view markup (to be confirmed by the spike)

| Element | Selector |
| :--- | :--- |
| Title | `.act-title, h3.text-center` |
| Act no. / date lines | `.act-no, .act-date, p.text-center`: "(ACT NO. XLV OF 1860)", "[6th October, 1860]" |
| Chapter heading | `.act-chapter-name, .act-chapter-group > p:first-child` |
| Section block | `.lineremove, .lineremoves` |
| Marginal heading | `.txt-head` |
| Section text | `.txt-details`: first paragraph starts "420." or "৪২০।" |
| Footnote marker | `sup` |
| Footnote entries | `.footnote li, .footnote p` |

The test fixtures in `apps/worker/test/fixtures/` follow these assumptions. When the live markup differs, update the defaults, replace the fixtures with real snapshots, and re-run `pnpm test`.

## DATA-01 spike status

**Blocked on 2026-11-03.** `robots.txt` answered once (`User-agent: * / Allow: /`). After that, every page request (index, `act-75.html`, `act-print-11.html`, plain HTTP and HTTPS) timed out after 30–90 s or had its connection reset, from the dev network.

To finish the spike:

1. From a network that reaches the portal, save the print view of these 10 Acts into `test/fixtures/`. They cover English pre-1987 Acts, Bangla post-1987 Acts and heavily amended Acts. Ids marked "?" must be looked up on the index:
   Penal Code 1860 (11) · CrPC 1898 (75) · Evidence Act 1872 (?) · CPC 1908 (?) · Negotiable Instruments Act 1881 (?) · Nari-o-Shishu Nirjatan Daman Ain 2000 (?) · Narcotics Control Act 2018 (?) · Cyber Security Act 2023 (?) · one repealed Act (?) · one Act with Bangla ক/খ inserted sections (?).
2. Check every selector above. Also check whether section bodies use `<p>` or `<br>`, and the footnote format.
3. Check whether the portal sends `ETag` / `Last-Modified`. If it doesn't, conditional GET is a no-op, and change detection relies on content hashes alone (which still works).
4. Measure the time per page. At more than about 10 s per page, a full crawl of ~1,480 Acts takes more than 4 h. If so, schedule the weekly full crawl accordingly.
