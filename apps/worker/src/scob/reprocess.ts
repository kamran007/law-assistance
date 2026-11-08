import { asc, gt, isNotNull, and, inArray, type SQL } from 'drizzle-orm';
import { judgments } from '@lawassist/db';
import type { Log } from '../scrape/run-scrape';
import { processScobJudgment, type ScobProcessDeps } from './process';

export interface ReprocessSummary {
  judgments: number;
  ok: number;
  needsReview: number;
  failed: number;
  withDecisionDate: number;
}

const PAGE = 25;

/**
 * Re-runs JUD-04/05 over judgments already stored, from the stored original PDFs (no request to the
 * Supreme Court site): after the text, metadata or linking rules change (`--scob-reprocess`). The
 * list fields come from the stored row; the case number only for issue 1, where the list gives it
 * (elsewhere it came from the PDF and is read again). Same PDF hash, so no revision row is written.
 */
export async function reprocessStoredJudgments(
  deps: Omit<ScobProcessDeps, 'http'> & { objects: ScobProcessDeps['objects'] & { get(key: string): Promise<Uint8Array> } },
  log: Log,
  opts: { judgmentIds?: string[] } = {},
): Promise<ReprocessSummary> {
  const summary: ReprocessSummary = { judgments: 0, ok: 0, needsReview: 0, failed: 0, withDecisionDate: 0 };
  let after: string | null = null;
  for (;;) {
    const conds: SQL[] = [isNotNull(judgments.storedPdfKey), ...(after ? [gt(judgments.judgmentId, after)] : []), ...(opts.judgmentIds ? [inArray(judgments.judgmentId, opts.judgmentIds)] : [])];
    const page: (typeof judgments.$inferSelect)[] = await deps.db.select().from(judgments).where(and(...conds)).orderBy(asc(judgments.judgmentId)).limit(PAGE);
    if (!page.length) break;
    for (const j of page) {
      summary.judgments++;
      const stored = j.storedPdfKey!;
      try {
        const out = await processScobJudgment(
          { ...deps, http: { getBytes: async (url) => ({ url, bytes: await deps.objects.get(stored), contentType: 'application/pdf', fetchedAt: new Date() }) } },
          {
            row: {
              issue: j.issueNumber,
              division: j.division,
              serial: j.serialNumber,
              parties: j.parties,
              authoringJudge: j.authoringJudge,
              citation: j.citation,
              caseNumber: j.issueNumber === 1 ? j.caseNumber : null,
              keyWords: j.keyWords,
              summary: j.summary,
              keyRatio: '',
              keyRatioParagraphs: j.keyRatioParagraphs,
              pdfUrl: j.sourcePdfUrl,
            },
            issueYear: j.issueYear,
            listingSnapshotKey: j.listingHtmlS3Key ?? 'reprocess',
            force: true,
          },
        );
        if (out.status === 'STORED' && out.extraction === 'OK') summary.ok++;
        else if (out.status === 'STORED') summary.needsReview++;
      } catch (err) {
        summary.failed++;
        log.warn({ judgmentId: j.judgmentId, err: err instanceof Error ? err.message : String(err) }, 'scob reprocess failed');
      }
    }
    after = page.at(-1)!.judgmentId;
    if (page.length < PAGE) break;
  }
  const rows = await deps.db.select({ d: judgments.decisionDate }).from(judgments).where(opts.judgmentIds ? inArray(judgments.judgmentId, opts.judgmentIds) : undefined);
  summary.withDecisionDate = rows.filter((r) => r.d).length;
  log.info(summary, 'scob reprocess done');
  return summary;
}
