import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoped, type CaseArtifact, type Db } from '@lawassist/db';
import { looksLikeBijoy } from '@lawassist/legal-text';
import { OcrNotConfiguredError, type OcrProvider } from '@lawassist/providers';
import { ToolError, type DocumentTools } from './tools';

/**
 * Scan pipeline stages 1–2 (TRD §8.2): sanitize → pre-process → text extraction. Consumes the
 * `scan` queue the API fills at registration (BE-21) and hands over to the `analysis` queue
 * (stage 3, BE-23). Runs as the document's owner through `scoped()` (TRD §4.3 point 5).
 */
export interface DocumentObjects {
  get(key: string): Promise<Uint8Array>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface AnalysisQueue {
  enqueue(job: { artifactId: string; ownerUserId: string }): Promise<void>;
}

export interface ScanDeps {
  db: Db;
  tools: DocumentTools;
  ocr: OcrProvider;
  objects: DocumentObjects;
  analysis: AnalysisQueue;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
  tmpRoot?: string;
}

/** Average non-space characters per page above which a PDF's own text layer is used, not OCR. */
export const TEXT_LAYER_MIN_CHARS_PER_PAGE = 100;
export const RASTER_DPI = 300;
export const MAX_OCR_PAGES = 50;

/** A problem with the document itself: reported to the user, never retried. */
export class ScanFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ScanFailure';
  }
}

export type ScanOutcome = { status: 'EXTRACTED'; method: 'TEXT_LAYER' | 'DOCX' | 'OCR' } | { status: 'FAILED'; code: string } | { status: 'SKIPPED'; reason: string };

/** Statuses from which stages 1–2 may (re)run; anything later means the work is already done. */
const STARTABLE: CaseArtifact['processingStatus'][] = ['UPLOADED', 'OCR'];

export async function processScanJob(deps: ScanDeps, job: { artifactId: string; ownerUserId: string }): Promise<ScanOutcome> {
  const repo = scoped(deps.db, job.ownerUserId);
  const artifact = await repo.artifacts.findById(job.artifactId);
  if (!artifact) return { status: 'SKIPPED', reason: 'deleted or not found' };
  if (!STARTABLE.includes(artifact.processingStatus)) return { status: 'SKIPPED', reason: `already ${artifact.processingStatus}` };
  if (!artifact.fileStorageKey || !artifact.mimeType) return fail(repo, job.artifactId, 'UNREADABLE_DOCUMENT');

  await repo.artifacts.setProcessing(job.artifactId, { processingStatus: 'OCR', processingError: null });
  const dir = join(deps.tmpRoot ?? tmpdir(), `scan-${job.artifactId}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const original = await deps.objects.get(artifact.fileStorageKey);
    const fileSha256 = createHash('sha256').update(original).digest('hex');
    const extracted = await extract(deps, artifact, original, dir);

    if (!extracted.text.trim()) return fail(repo, job.artifactId, 'UNREADABLE_DOCUMENT');
    if (looksLikeBijoy({ text: extracted.text, fontNames: extracted.fontNames })) {
      // The Bijoy → Unicode converter is DATA-11. Until then, say so instead of analysing garbage.
      return fail(repo, job.artifactId, 'BIJOY_CONVERSION_UNAVAILABLE');
    }

    const stillThere = await repo.artifacts.setProcessing(job.artifactId, {
      processingStatus: 'EXTRACTING',
      rawExtractedText: extracted.text,
      ocrConfidence: extracted.confidence,
      pageCount: extracted.pageCount,
      fileSha256,
    });
    if (!stillThere) return { status: 'SKIPPED', reason: 'deleted during processing' };
    await deps.analysis.enqueue({ artifactId: job.artifactId, ownerUserId: job.ownerUserId }); // ids only
    // IDs and counts only: never document text (TRD §12.3).
    deps.log.info({ artifactId: job.artifactId, method: extracted.method, pages: extracted.pageCount, chars: extracted.text.length }, 'scan text extracted');
    return { status: 'EXTRACTED', method: extracted.method };
  } catch (err) {
    if (err instanceof ScanFailure) return fail(repo, job.artifactId, err.code);
    if (err instanceof ToolError) return fail(repo, job.artifactId, err.code);
    if (err instanceof OcrNotConfiguredError) return fail(repo, job.artifactId, 'OCR_NOT_CONFIGURED');
    throw err; // infrastructure trouble (S3, DB, timeouts): BullMQ retries; see markFailedAfterRetries
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Extracted {
  text: string;
  method: 'TEXT_LAYER' | 'DOCX' | 'OCR';
  pageCount: number | null;
  confidence: number | null;
  fontNames: string[];
}

async function extract(deps: ScanDeps, a: CaseArtifact, original: Uint8Array, dir: string): Promise<Extracted> {
  switch (a.mimeType) {
    case 'application/pdf': {
      const raw = join(dir, 'original.pdf');
      const clean = join(dir, 'sanitized.pdf');
      await writeFile(raw, original);
      // Nothing parses the upload before qpdf has rewritten it (TRD §12.6).
      await deps.tools.sanitizePdf(raw, clean);
      await deps.objects.put(a.fileStorageKey!.replace(/original\.pdf$/, 'sanitized.pdf'), new Uint8Array(await readFile(clean)), 'application/pdf');

      const pages = await deps.tools.pdfTextPages(clean);
      const fontNames = await deps.tools.pdfFontNames(clean);
      const chars = pages.reduce((n, p) => n + p.replace(/\s/g, '').length, 0);
      if (pages.length && chars / pages.length >= TEXT_LAYER_MIN_CHARS_PER_PAGE) {
        return { text: pages.join('\n\f\n'), method: 'TEXT_LAYER', pageCount: pages.length, confidence: null, fontNames };
      }
      if (pages.length > MAX_OCR_PAGES) throw new ScanFailure('TOO_MANY_PAGES');
      const images = await deps.tools.rasterizePdf(clean, dir, RASTER_DPI, MAX_OCR_PAGES);
      // OCR reads glyphs and returns Unicode, so the PDF's (maybe Bijoy) fonts no longer matter.
      return { ...(await ocr(deps, await Promise.all(images.map((i) => deps.tools.normalizeImage(i))))), fontNames: [] };
    }
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return { text: await deps.tools.docxText(original), method: 'DOCX', pageCount: null, confidence: null, fontNames: [] };
    case 'image/jpeg':
    case 'image/png':
      return { ...(await ocr(deps, [await deps.tools.normalizeImage(original)])), fontNames: [] };
    default:
      throw new ScanFailure('UNSUPPORTED_TYPE');
  }
}

async function ocr(deps: ScanDeps, pages: Uint8Array[]): Promise<Omit<Extracted, 'fontNames'>> {
  const results = await deps.ocr.read(pages, { hints: ['bn', 'en'] });
  const confidence = results.length ? results.reduce((s, r) => s + r.confidence, 0) / results.length : 0;
  return { text: results.map((r) => r.text).join('\n\f\n'), method: 'OCR', pageCount: pages.length, confidence };
}

async function fail(repo: ReturnType<typeof scoped>, artifactId: string, code: string): Promise<ScanOutcome> {
  await repo.artifacts.setProcessing(artifactId, { processingStatus: 'FAILED', processingError: code });
  return { status: 'FAILED', code };
}

/** Called by the queue worker when a job has used up its retries on an infrastructure error. */
export async function markFailedAfterRetries(db: Db, job: { artifactId: string; ownerUserId: string }): Promise<void> {
  await scoped(db, job.ownerUserId).artifacts.setProcessing(job.artifactId, { processingStatus: 'FAILED', processingError: 'PROCESSING_ERROR' });
}
