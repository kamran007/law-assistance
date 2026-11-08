import { readFileSync } from 'node:fs';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { createDb, judgmentRevisions, judgments, outboxEvents, runMigrations, type Db } from '@lawassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScobJudgmentJob } from '../src/scob/crawl';
import { judgmentPdfKey, processScobJudgment, type ScobProcessDeps } from '../src/scob/process';
import { scobJudgmentJobSchema } from '../src/scob/queue';

/**
 * JUD-04 against MySQL 8.4 (Testcontainers). Download and PDF tools are fakes: the text comes from a
 * real judgment header saved in the JUD-01 spike. The real qpdf / Poppler path is in scob.real.test.ts.
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 3 }));
}, 180_000);
afterAll(async () => {
  await close?.();
  await container?.stop();
});

const headerPage = readFileSync(new URL('./fixtures/scob/header_hd14_1.txt', import.meta.url), 'utf8');
const body = (n: number) => `${n}. ${'The petitioner challenges the order under section 63 of the Act. '.repeat(6)}`;
const PAGES = [headerPage, `14 SCOB [2020] HCD\n${body(1)}\n${body(2)}\n2`, `14 SCOB [2020] HCD\n${body(3)}\n3`];

const pdf = (marker: string) => new TextEncoder().encode(`%PDF-1.4\n% ${marker}\n`);

function harness(opts: { bytes?: Uint8Array; pages?: string[] } = {}) {
  const stored = new Map<string, Uint8Array>();
  const calls = { sanitize: 0 };
  const deps: ScobProcessDeps = {
    db,
    http: { getBytes: async (url) => ({ url, bytes: opts.bytes ?? pdf('v1'), contentType: 'application/pdf', fetchedAt: new Date() }) },
    tools: {
      sanitizePdf: async () => void calls.sanitize++,
      pdfTextPages: async () => opts.pages ?? PAGES,
      pdfFontNames: async () => ['TimesNewRoman'],
    },
    objects: { put: async (key, bytes) => void stored.set(key, bytes) },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  return { deps, stored, calls };
}

const job = (over: Partial<ScobJudgmentJob['row']> = {}, force = false): ScobJudgmentJob => ({
  row: {
    issue: 14,
    division: 'HCD',
    serial: 1,
    parties: 'Grameenphone Limited Vs. BTRC & ors',
    authoringJudge: 'SYED REFAAT AHMED, J',
    citation: '14 SCOB [2020] HCD',
    caseNumber: null,
    keyWords: 'The Bangladesh Telecommunication Regulation Act Section 63 and 65;',
    summary: null,
    keyRatio: 'It is our finding …',
    keyRatioParagraphs: [],
    pdfUrl: 'https://www.supremecourt.gov.bd/resources/bulletin/14_SCOB_HD_1.pdf',
    ...over,
  },
  issueYear: 2020,
  listingSnapshotKey: 'raw/scob/lists/14/HCD/x.html.gz',
  force,
});

const byNaturalKey = async (serial: number) => (await db.select().from(judgments).where(eq(judgments.serialNumber, serial)))[0]!;

describe('processScobJudgment', () => {
  it('stores a new judgment: list fields, PDF metadata, [para n] text, stored PDF, outbox event', async () => {
    const h = harness();
    const out = await processScobJudgment(h.deps, job());
    // The saved header is the real pages 1–4: paragraphs 1–23 of the judgment are already there.
    expect(out).toMatchObject({ status: 'STORED', extraction: 'OK', changed: true, paragraphs: 23 });
    const j = await byNaturalKey(1);
    expect(j).toMatchObject({
      citation: '14 SCOB [2020] HCD',
      parties: 'Grameenphone Limited Vs. BTRC & ors',
      caseNumber: 'WRIT PETITION NO. 1774 OF 2017',
      decisionDate: '2019-08-25',
      decisionDateSource: 'PDF_RULE',
      bench: ['Mr. Justice Syed Refaat Ahmed', 'Mr. Justice Md. Iqbal Kabir'],
      language: 'EN',
      extractionStatus: 'OK',
      listingHtmlS3Key: 'raw/scob/lists/14/HCD/x.html.gz',
    });
    expect(j.fullText).toContain('[para 1] Pursuant to this Application under Article 102');
    expect(j.fullText).toContain('[para 2] The Petitioner is a company');
    expect(j.fullText).toContain('[para 23] Furthermore');
    expect(j.fullText).not.toMatch(/^14 SCOB \[2020\] HCD$/m); // running head removed
    expect(j.storedPdfKey).toBe(judgmentPdfKey(job().row, j.pdfSha256!));
    expect(h.stored.has(j.storedPdfKey!)).toBe(true);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, j.judgmentId));
    expect(events.map((e) => e.eventType)).toEqual(['JUDGMENT_UPSERTED']);
  });

  it('the same PDF again is UNCHANGED (no tools, no new event); a changed PDF keeps the old text as a revision', async () => {
    const same = harness();
    const before = await byNaturalKey(1);
    expect(await processScobJudgment(same.deps, job())).toEqual({ status: 'UNCHANGED', judgmentId: before.judgmentId });
    expect(same.calls.sanitize).toBe(0);

    const changed = harness({ bytes: pdf('v2'), pages: [headerPage, `${body(1)}\n${body(2)} Corrected.`] });
    expect(await processScobJudgment(changed.deps, job())).toMatchObject({ status: 'STORED', judgmentId: before.judgmentId, changed: true });
    const revisions = await db.select().from(judgmentRevisions).where(eq(judgmentRevisions.judgmentId, before.judgmentId));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ pdfSha256: before.pdfSha256, fullText: before.fullText });
    expect((await byNaturalKey(1)).fullText).toContain('Corrected.');
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, before.judgmentId));
    expect(events).toHaveLength(2);
  });

  it('issue-1 style rows (case number only) take parties, judge and citation from the PDF', async () => {
    const h = harness({ bytes: pdf('issue1') });
    await processScobJudgment(h.deps, job({ serial: 2, parties: '', authoringJudge: null, citation: null, caseNumber: 'WRIT PETITION NO.1774 OF 2017' }));
    expect(await byNaturalKey(2)).toMatchObject({
      parties: 'Grameenphone Limited Vs. Bangladesh Telecommunication Regulatory Commission (BTRC) & ors.',
      authoringJudge: 'SYED REFAAT AHMED, J',
      citation: '14 SCOB [2020] HCD',
      caseNumber: 'WRIT PETITION NO.1774 OF 2017',
    });
  });

  it('too little text (scanned) or a file that is not a PDF is stored as NEEDS_REVIEW for the admin queue', async () => {
    const scanned = harness({ bytes: pdf('scan'), pages: ['', ' ', 'x'] });
    expect(await processScobJudgment(scanned.deps, job({ serial: 3 }))).toMatchObject({ status: 'STORED', extraction: 'NEEDS_REVIEW' });

    const html = harness({ bytes: new TextEncoder().encode('<html>Not found</html>') });
    expect(await processScobJudgment(html.deps, job({ serial: 4 }))).toMatchObject({ extraction: 'NEEDS_REVIEW' });
    expect(html.calls.sanitize).toBe(0);
    expect(await byNaturalKey(4)).toMatchObject({ storedPdfKey: null, extractionStatus: 'NEEDS_REVIEW', fullText: null });
    expect(html.stored.size).toBe(0);
  });

  it('job payloads from Redis are validated (SCOB PDFs only)', () => {
    expect(scobJudgmentJobSchema.safeParse(job()).success).toBe(true);
    expect(scobJudgmentJobSchema.safeParse(job({ pdfUrl: 'https://evil.test/x.pdf' })).success).toBe(false);
  });
});
