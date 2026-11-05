import { copyFile } from 'node:fs/promises';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { createDb, newId, runMigrations, scoped, users, type Db } from '@lawassist/db';
import { notConfiguredOcr, type OcrProvider } from '@lawassist/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markFailedAfterRetries, processScanJob, TEXT_LAYER_MIN_CHARS_PER_PAGE, type ScanDeps } from '../src/scan/pipeline';
import { ToolError, type DocumentTools } from '../src/scan/tools';

/**
 * Scan pipeline stages 1–2 (BE-22) against MySQL 8.4 (Testcontainers, needs Docker). Tools, OCR and
 * S3 are fakes here; the real binaries are covered by tools.real.test.ts.
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;
let owner = '';
let caseId = '';

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));
  owner = newId();
  await db.insert(users).values({ userId: owner, fullName: 'Owner', contactIdentifier: 'owner@example.com' });
  caseId = (await scoped(db, owner).caseFiles.create({ title: 'FIR' }, { withConversation: false })).caseFileId;
}, 180_000);

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const longPage = (s: string) => `${s} `.repeat(Math.ceil(TEXT_LAYER_MIN_CHARS_PER_PAGE / s.length) + 2);

/** Fake tools: behaviour per test via the `pdf` script. */
function fakeTools(pdf: { pages?: string[]; fonts?: string[]; sanitizeError?: ToolError } = {}): DocumentTools & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async sanitizePdf(inPath, outPath) {
      calls.push('sanitize');
      if (pdf.sanitizeError) throw pdf.sanitizeError;
      await copyFile(inPath, outPath); // like qpdf, writes the rewritten file
    },
    async pdfTextPages() {
      calls.push('pdftotext');
      return pdf.pages ?? [];
    },
    async pdfFontNames() {
      return pdf.fonts ?? [];
    },
    async rasterizePdf(_p, _d, _dpi, max) {
      calls.push('rasterize');
      return (pdf.pages ?? []).slice(0, max).map(() => new Uint8Array([1]));
    },
    async docxText() {
      calls.push('docx');
      return 'Bail petition draft text';
    },
    async normalizeImage(b) {
      calls.push('normalize');
      return b;
    },
  };
}

function harness(tools: DocumentTools, ocr: OcrProvider = notConfiguredOcr, opts: { s3Fails?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const analysis: { artifactId: string; ownerUserId: string }[] = [];
  const logs: object[] = [];
  const deps: ScanDeps = {
    db,
    tools,
    ocr,
    objects: {
      get: async (k) => {
        if (opts.s3Fails) throw new Error('ECONNRESET');
        return objects.get(k) ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      },
      put: async (k, b) => void objects.set(k, b),
    },
    analysis: { enqueue: async (j) => void analysis.push(j) },
    log: { info: (o) => void logs.push(o), warn: (o) => void logs.push(o) },
  };
  return { deps, objects, analysis, logs };
}

async function upload(mimeType: string) {
  const artifactId = newId();
  const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[mimeType] ?? 'docx';
  const key = `tenants/${owner}/cases/${caseId}/${artifactId}/original.${ext}`;
  await scoped(db, owner).artifacts.createUpload({ artifactId, caseFileId: caseId, artifactType: 'FIR_SCAN', fileStorageKey: key, mimeType });
  return { artifactId, ownerUserId: owner, key };
}

const row = async (id: string) => (await scoped(db, owner).artifacts.findById(id))!;

describe('processScanJob', () => {
  it('uses a PDF’s text layer: sanitizes first, stores the sanitized copy, hands over to analysis', async () => {
    const tools = fakeTools({ pages: [longPage('ধারা ৪২০ প্রতারণা'), longPage('FIR No. 12')] });
    const h = harness(tools);
    const job = await upload('application/pdf');
    expect(await processScanJob(h.deps, job)).toEqual({ status: 'EXTRACTED', method: 'TEXT_LAYER', bijoy: false });
    expect(tools.calls.slice(0, 2)).toEqual(['sanitize', 'pdftotext']); // nothing parses before qpdf
    expect(tools.calls).not.toContain('rasterize');
    expect([...h.objects.keys()]).toEqual([job.key.replace('original.pdf', 'sanitized.pdf')]);
    const a = await row(job.artifactId);
    expect(a).toMatchObject({ processingStatus: 'EXTRACTING', processingError: null, pageCount: 2, ocrConfidence: null });
    expect(a.rawExtractedText).toContain('ধারা ৪২০');
    expect(a.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.analysis).toEqual([{ artifactId: job.artifactId, ownerUserId: owner }]);
    expect(JSON.stringify(h.logs)).not.toContain('ধারা'); // no document text in logs
  });

  it('OCRs a scanned PDF (little text per page) and records the confidence', async () => {
    const tools = fakeTools({ pages: ['', ' 1 '] });
    const ocr: OcrProvider = { read: async (pages) => pages.map((_, i) => ({ text: `page ${i + 1} এজাহার`, confidence: i ? 0.8 : 0.9 })) };
    const h = harness(tools, ocr);
    const job = await upload('application/pdf');
    expect(await processScanJob(h.deps, job)).toEqual({ status: 'EXTRACTED', method: 'OCR', bijoy: false });
    expect(tools.calls).toContain('rasterize');
    const a = await row(job.artifactId);
    expect(a.ocrConfidence).toBeCloseTo(0.85);
    expect(a).toMatchObject({ processingStatus: 'EXTRACTING', pageCount: 2 });
  });

  it('extracts DOCX text without OCR', async () => {
    const h = harness(fakeTools());
    const job = await upload('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(await processScanJob(h.deps, job)).toEqual({ status: 'EXTRACTED', method: 'DOCX', bijoy: false });
    expect((await row(job.artifactId)).rawExtractedText).toBe('Bail petition draft text');
  });

  it('fails clearly, without retries, when the document needs OCR and none is configured (BE-20)', async () => {
    const h = harness(fakeTools());
    const job = await upload('image/jpeg');
    expect(await processScanJob(h.deps, job)).toEqual({ status: 'FAILED', code: 'OCR_NOT_CONFIGURED' });
    expect(await row(job.artifactId)).toMatchObject({ processingStatus: 'FAILED', processingError: 'OCR_NOT_CONFIGURED' });
    expect(h.analysis).toEqual([]);
  });

  it('converts Bijoy (SutonnyMJ) text to Unicode before analysis (DATA-11), detected by text or by font', async () => {
    const byText = harness(fakeTools({ pages: [longPage('`Ûwewai 302/34 aviv †gvt Avjx †mvbvi')] }));
    const a = await upload('application/pdf');
    expect(await processScanJob(byText.deps, a)).toEqual({ status: 'EXTRACTED', method: 'TEXT_LAYER', bijoy: true });
    const text = (await row(a.artifactId)).rawExtractedText!;
    expect(text).toContain('দন্ডবিধির ৩০২/৩৪ ধারা মোঃ আলী সোনার');
    expect(text).not.toMatch(/[†‡Û]/);
    expect(byText.analysis).toHaveLength(1);
    expect(JSON.stringify(byText.logs)).not.toContain('ধারা'); // still no document text in logs

    // The font says SutonnyMJ although the text has none of the typical marks: still converted.
    const byFont = harness(fakeTools({ pages: [longPage('Avgvi gvgjv')], fonts: ['ABCDEF+SutonnyMJ'] }));
    const b = await upload('application/pdf');
    expect(await processScanJob(byFont.deps, b)).toEqual({ status: 'EXTRACTED', method: 'TEXT_LAYER', bijoy: true });
    expect((await row(b.artifactId)).rawExtractedText).toContain('আমার মামলা');
  });

  it('reports unusable files with the tool’s code', async () => {
    const h = harness(fakeTools({ sanitizeError: new ToolError('PDF_ENCRYPTED', 'x') }));
    const job = await upload('application/pdf');
    expect(await processScanJob(h.deps, job)).toEqual({ status: 'FAILED', code: 'PDF_ENCRYPTED' });
    const empty = harness(fakeTools({ pages: [longPage('   ').replace(/\S/g, ' ')] }), { read: async () => [{ text: '  ', confidence: 0.1 }] });
    const job2 = await upload('application/pdf');
    expect(await processScanJob(empty.deps, job2)).toEqual({ status: 'FAILED', code: 'UNREADABLE_DOCUMENT' });
  });

  it('is idempotent: skips deleted documents and work that is already done', async () => {
    const tools = fakeTools({ pages: [longPage('text')] });
    const h = harness(tools);
    const job = await upload('application/pdf');
    await processScanJob(h.deps, job);
    expect(await processScanJob(h.deps, job)).toEqual({ status: 'SKIPPED', reason: 'already EXTRACTING' });
    expect(h.analysis).toHaveLength(1);

    const gone = await upload('application/pdf');
    await scoped(db, owner).artifacts.softDelete(gone.artifactId);
    expect((await processScanJob(h.deps, gone)).status).toBe('SKIPPED');
    // A job naming another user's document finds nothing (scoped by owner).
    expect((await processScanJob(h.deps, { artifactId: job.artifactId, ownerUserId: newId() })).status).toBe('SKIPPED');
  });

  it('lets infrastructure errors propagate for BullMQ to retry, then marks the document failed', async () => {
    const h = harness(fakeTools({ pages: [longPage('text')] }), notConfiguredOcr, { s3Fails: true });
    const job = await upload('application/pdf');
    await expect(processScanJob(h.deps, job)).rejects.toThrow('ECONNRESET');
    expect((await row(job.artifactId)).processingStatus).toBe('OCR'); // retry can resume from here
    await markFailedAfterRetries(db, job);
    expect(await row(job.artifactId)).toMatchObject({ processingStatus: 'FAILED', processingError: 'PROCESSING_ERROR' });
  });
});
