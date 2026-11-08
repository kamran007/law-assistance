import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgmentRevisions, judgments, newId, outboxEvents, type Db } from '@lawassist/db';
import { convertBijoyDocument, looksLikeBijoy } from '@lawassist/legal-text';
import { and, eq } from 'drizzle-orm';
import type { DocumentTools } from '../scan/tools';
import type { PoliteHttpClient } from '../scrape/http-client';
import type { Log } from '../scrape/run-scrape';
import type { ScobJudgmentJob } from './crawl';
import { parseJudgmentHeader } from './pdf-metadata';
import { findStatuteRefs, replaceStatuteRefs, sectionKeysOf, StatuteLinker } from './statute-links';
import { averageCharsPerPage, cleanPages, commonBanglaShare, detectLanguage, markParagraphs, MIN_CHARS_PER_PAGE, MIN_COMMON_BANGLA_SHARE } from './text';

/** TRD §6A.3 step 1. */
export const MAX_JUDGMENT_PDF_BYTES = 50 * 1024 * 1024;
/** Pages the header metadata is read from. */
const HEADER_PAGES = 4;

export interface ScobProcessDeps {
  /** The scraper connection (app_scraper). */
  db: Db;
  http: Pick<PoliteHttpClient, 'getBytes'>;
  tools: Pick<DocumentTools, 'sanitizePdf' | 'pdfTextPages' | 'pdfFontNames'>;
  /** Object storage for the original PDFs (public data, not tenant files). */
  objects: { put(key: string, bytes: Uint8Array, contentType: string): Promise<void> };
  log: Log;
  /** Reused across judgments in one worker (caches the statute titles); a fresh one per call otherwise. */
  linker?: StatuteLinker;
}

export type ScobProcessOutcome =
  | { status: 'STORED'; judgmentId: string; extraction: 'OK' | 'NEEDS_REVIEW'; changed: boolean; paragraphs: number; statuteLinks: number }
  | { status: 'UNCHANGED'; judgmentId: string };

/** `raw/scob/{issue}/{division}/{serial}/{pdf_sha256}.pdf` (TRD §4.2). */
export const judgmentPdfKey = (j: Pick<ScobJudgmentJob['row'], 'issue' | 'division' | 'serial'>, sha256: string) => `raw/scob/${j.issue}/${j.division}/${j.serial}/${sha256}.pdf`;

const isPdf = (b: Uint8Array) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

/**
 * One SCOB judgment (TRD §6A.3; JUD-04): fetch → hash (unchanged → stop) → qpdf → text (Bijoy
 * converted; too little text → NEEDS_REVIEW until OCR exists) → `[para n]` markers → header
 * metadata (rules) → statute links (JUD-05) → store the PDF → one transaction: upsert, old text to
 * `judgment_revisions` when the PDF changed, replace `judgment_statute_refs`, outbox
 * `JUDGMENT_UPSERTED`. A file that
 * isn't a usable PDF is stored as NEEDS_REVIEW so it shows in the admin queue instead of retrying.
 */
export async function processScobJudgment(deps: ScobProcessDeps, job: ScobJudgmentJob): Promise<ScobProcessOutcome> {
  const { row } = job;
  const naturalKey = and(eq(judgments.source, 'SCOB'), eq(judgments.issueNumber, row.issue), eq(judgments.division, row.division), eq(judgments.serialNumber, row.serial));
  const [existing] = await deps.db.select().from(judgments).where(naturalKey).limit(1);

  const file = await deps.http.getBytes(row.pdfUrl, 'application/pdf');
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  if (existing && existing.pdfSha256 === sha256 && !job.force) {
    await deps.db.update(judgments).set({ lastSyncedAt: new Date() }).where(eq(judgments.judgmentId, existing.judgmentId));
    return { status: 'UNCHANGED', judgmentId: existing.judgmentId };
  }

  let pages: string[] = [];
  let fontNames: string[] = [];
  let usable = isPdf(file.bytes) && file.bytes.length <= MAX_JUDGMENT_PDF_BYTES;
  if (usable) {
    const dir = await mkdtemp(join(tmpdir(), 'scob-'));
    try {
      const raw = join(dir, 'in.pdf');
      const clean = join(dir, 'clean.pdf');
      await writeFile(raw, file.bytes);
      await deps.tools.sanitizePdf(raw, clean);
      [pages, fontNames] = await Promise.all([deps.tools.pdfTextPages(clean), deps.tools.pdfFontNames(clean)]);
    } catch (err) {
      usable = false;
      deps.log.warn({ issue: row.issue, division: row.division, serial: row.serial, err: err instanceof Error ? err.message : String(err) }, 'scob pdf unusable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const joined = pages.join('\n');
  const bijoy = usable && looksLikeBijoy({ text: joined, fontNames });
  if (bijoy) pages = pages.map((p) => convertBijoyDocument(p));
  // Converted from a legacy font: if the result isn't readable Bangla (another, unknown legacy
  // encoding), keep it out of search and show the PDF instead until it is fixed (NEEDS_REVIEW).
  const readable = !bijoy || commonBanglaShare(pages.join(' ')) >= MIN_COMMON_BANGLA_SHARE;
  const enoughText = usable && readable && averageCharsPerPage(pages) >= MIN_CHARS_PER_PAGE;
  const header = parseJudgmentHeader(pages.slice(0, HEADER_PAGES).join('\n'));
  const { text: fullText, paragraphs } = markParagraphs(cleanPages(pages));
  const links = await (deps.linker ?? new StatuteLinker(deps.db)).resolve(findStatuteRefs(row.keyWords, fullText || null));

  const storedPdfKey = isPdf(file.bytes) ? judgmentPdfKey(row, sha256) : null;
  if (storedPdfKey) await deps.objects.put(storedPdfKey, file.bytes, 'application/pdf');

  const yearFromCitation = Number(/\[\s*(\d{4})\s*\]/.exec(row.citation ?? header.citation ?? '')?.[1]) || null;
  const issueYear = job.issueYear ?? yearFromCitation ?? 0;
  const values = {
    issueYear,
    // As published in the list; the PDF fills what the list doesn't give (issue 1 rows).
    citation: row.citation ?? header.citation ?? `${row.issue} SCOB [${issueYear}] ${row.division}`,
    caseNumber: row.caseNumber ?? header.caseNumbers[0] ?? null,
    parties: row.parties || header.parties || '',
    authoringJudge: row.authoringJudge ?? header.authoringJudge,
    bench: header.bench.length ? header.bench : null,
    decisionDate: header.decisionDate,
    decisionDateSource: header.decisionDate ? ('PDF_RULE' as const) : null,
    keyWords: row.keyWords,
    summary: row.summary,
    keyRatioParagraphs: row.keyRatioParagraphs,
    language: detectLanguage(fullText),
    fullText: enoughText ? fullText : fullText || null,
    sourcePdfUrl: row.pdfUrl,
    storedPdfKey,
    pdfSha256: sha256,
    listingHtmlS3Key: job.listingSnapshotKey,
    normalizedSectionKeys: sectionKeysOf(links),
    extractionStatus: enoughText ? ('OK' as const) : ('NEEDS_REVIEW' as const),
    lastSyncedAt: new Date(),
  };

  const judgmentId = await deps.db.transaction(async (tx) => {
    const [current] = await tx.select().from(judgments).where(naturalKey).for('update');
    if (current) {
      if (current.pdfSha256 && current.pdfSha256 !== sha256) {
        await tx.insert(judgmentRevisions).values({ revisionId: newId(), judgmentId: current.judgmentId, pdfSha256: current.pdfSha256, storedPdfKey: current.storedPdfKey, fullText: current.fullText });
      }
      await tx.update(judgments).set(values).where(eq(judgments.judgmentId, current.judgmentId));
      await replaceStatuteRefs(tx, current.judgmentId, links);
      await tx.insert(outboxEvents).values({ aggregate: 'judgment', aggregateId: current.judgmentId, eventType: 'JUDGMENT_UPSERTED', payload: { changed: current.pdfSha256 !== sha256 } });
      return current.judgmentId;
    }
    const id = newId();
    await tx.insert(judgments).values({ judgmentId: id, source: 'SCOB', issueNumber: row.issue, division: row.division, serialNumber: row.serial, ...values });
    await replaceStatuteRefs(tx, id, links);
    await tx.insert(outboxEvents).values({ aggregate: 'judgment', aggregateId: id, eventType: 'JUDGMENT_UPSERTED', payload: { changed: true } });
    return id;
  });

  const statuteLinks = values.normalizedSectionKeys.length;
  deps.log.info({ judgmentId, issue: row.issue, division: row.division, serial: row.serial, pages: pages.length, paragraphs, bijoy, readable, statuteLinks, extraction: values.extractionStatus }, 'scob judgment stored');
  return { status: 'STORED', judgmentId, extraction: values.extractionStatus, changed: !existing || existing.pdfSha256 !== sha256, paragraphs, statuteLinks };
}
