import { judgments, newId, scrapeEvents, scrapeRuns, type Db } from '@lawassist/db';
import { and, eq } from 'drizzle-orm';
import type { PoliteHttpClient } from '../scrape/http-client';
import type { Log } from '../scrape/run-scrape';
import type { SnapshotStore } from '../scrape/snapshot-store';
import { decodeMixedUtf8 } from './decode';
import { parseDivisionList, parseIndex, type ScobListRow } from './list-parser';
import { SCOB_SOURCE_CONFIG as cfg, type Division } from './source-config';

/** One judgment to fetch and process (JUD-04, queue `scob-judgment`). */
export interface ScobJudgmentJob {
  row: ScobListRow;
  issueYear: number | null;
  listingSnapshotKey: string;
  /** Re-download and re-process even if the stored PDF hash matches. */
  force: boolean;
}

export interface ScobJudgmentQueue {
  enqueue(jobs: ScobJudgmentJob[]): Promise<void>;
}

export interface ScobCrawlDeps {
  /** The scraper connection (app_scraper): case-law and scrape tables only. */
  db: Db;
  http: Pick<PoliteHttpClient, 'getBytes'>;
  snapshots: Pick<SnapshotStore, 'putKey'>;
  queue: ScobJudgmentQueue;
  log: Log;
}

export type ScobCrawlKind = 'WEEKLY' | 'BACKFILL' | 'MANUAL';

export interface ScobCrawlRequest {
  kind: ScobCrawlKind;
  /** Limit to these issue numbers (manual runs). */
  issues?: number[];
  /** Queue every listed judgment, not only those not stored yet (backfill / repair). */
  all?: boolean;
}

export interface ScobCrawlSummary {
  runId: string;
  status: 'SUCCEEDED' | 'FAILED';
  issues: number;
  listsFetched: number;
  listsFailed: number;
  rows: number;
  queued: number;
}

/** `raw/scob/lists/{issue}/{division}/{fetched_at}.html.gz` (TRD §6A.1). */
export const listSnapshotKey = (issue: number, division: Division, fetchedAt: Date) =>
  `raw/scob/lists/${issue}/${division}/${fetchedAt.toISOString().replace(/:/g, '-')}.html.gz`;

/** Stable BullMQ job id: a re-run while a judgment is still queued doesn't add a second job. */
export const judgmentJobId = (r: Pick<ScobListRow, 'issue' | 'division' | 'serial'>) => `scob-${r.issue}-${r.division}-${r.serial}`;

/**
 * SCOB crawl (TRD §6A.1–6A.2): index → AD / HCD list of each issue → rows → one `scob-judgment`
 * job per judgment that isn't stored yet (all of them for a backfill with `all`). List pages are
 * snapshotted. A failing list is logged and skipped; a failing index fails the run. Logs carry ids
 * and counts only.
 */
export async function runScobCrawl(deps: ScobCrawlDeps, req: ScobCrawlRequest): Promise<ScobCrawlSummary> {
  const runId = newId();
  await deps.db.insert(scrapeRuns).values({ runId, source: 'SCOB', kind: req.kind });
  const event = (level: 'INFO' | 'WARN' | 'ERROR', message: string) => deps.db.insert(scrapeEvents).values({ eventId: newId(), runId, level, message });
  const summary: ScobCrawlSummary = { runId, status: 'SUCCEEDED', issues: 0, listsFetched: 0, listsFailed: 0, rows: 0, queued: 0 };

  try {
    const index = await deps.http.getBytes(new URL(cfg.indexPath, cfg.baseUrl).toString(), 'text/html');
    let issues = parseIndex(decodeMixedUtf8(index.bytes));
    if (issues.length === 0) throw new Error('SCOB index: no issues found (layout changed?)');
    if (req.issues?.length) issues = issues.filter((i) => req.issues!.includes(i.issue));
    summary.issues = issues.length;

    for (const issue of issues) {
      for (const division of ['AD', 'HCD'] as const) {
        const url = issue.lists[division];
        if (!url) {
          await event('WARN', `Issue ${issue.issue}: no ${division} list link`);
          continue;
        }
        let rows: ScobListRow[];
        let snapshotKey: string;
        try {
          const page = await deps.http.getBytes(url, 'text/html');
          const html = decodeMixedUtf8(page.bytes);
          snapshotKey = await deps.snapshots.putKey(listSnapshotKey(issue.issue, division, page.fetchedAt), html);
          rows = parseDivisionList(html, { issue: issue.issue, division });
          summary.listsFetched++;
        } catch (err) {
          summary.listsFailed++;
          await event('ERROR', `Issue ${issue.issue} ${division}: list failed (${err instanceof Error ? err.message : String(err)})`);
          continue;
        }
        if (rows.length === 0) await event('WARN', `Issue ${issue.issue} ${division}: no judgment rows (layout changed?)`);
        summary.rows += rows.length;

        const stored = req.all
          ? new Set<number>()
          : new Set(
              (
                await deps.db
                  .select({ serial: judgments.serialNumber })
                  .from(judgments)
                  .where(and(eq(judgments.source, 'SCOB'), eq(judgments.issueNumber, issue.issue), eq(judgments.division, division)))
              ).map((r) => r.serial),
            );
        const jobs = rows
          .filter((r) => !stored.has(r.serial))
          .map((row): ScobJudgmentJob => ({ row, issueYear: issue.year, listingSnapshotKey: snapshotKey, force: req.all === true }));
        if (jobs.length) await deps.queue.enqueue(jobs);
        summary.queued += jobs.length;
      }
    }
    if (summary.listsFetched === 0) throw new Error('No division list could be fetched');
  } catch (err) {
    summary.status = 'FAILED';
    const message = err instanceof Error ? err.message : String(err);
    await event('ERROR', message);
    await deps.db.update(scrapeRuns).set({ status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date(), details: summary }).where(eq(scrapeRuns.runId, runId));
    deps.log.error({ ...summary }, 'scob crawl failed');
    return summary;
  }
  await deps.db.update(scrapeRuns).set({ status: 'SUCCEEDED', finishedAt: new Date(), details: summary }).where(eq(scrapeRuns.runId, runId));
  deps.log.info({ ...summary }, 'scob crawl finished');
  return summary;
}
