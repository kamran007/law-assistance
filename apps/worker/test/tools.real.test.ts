import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertBijoyDocument, looksLikeBijoy } from '@lawassist/legal-text';
import { CliDocumentTools, MAX_IMAGE_EDGE, run, ToolError } from '../src/scan/tools';

/**
 * The real document tools (BE-22). The qpdf/Poppler part needs those binaries (worker image, CI);
 * it is skipped where they are missing. sharp and mammoth run everywhere.
 */
const has = (cmd: string, arg = '-v') => {
  const r = spawnSync(cmd, [arg], { windowsHide: true });
  return !r.error;
};
const binaries = has('qpdf', '--version') && has('pdftotext') && has('pdftoppm') && has('pdffonts');
// CI and the worker image set this, so a missing binary there is a failure, not a silent skip.
if (process.env.REQUIRE_DOC_TOOLS && !binaries) throw new Error('REQUIRE_DOC_TOOLS is set but qpdf/Poppler are not installed');

/** A valid PDF with one text line per page in Helvetica (xref offsets computed). */
export function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const content = `BT /F1 11 Tf 40 800 Td 14 TL ${text
      .match(/.{1,90}/g)!
      .map((l) => `(${l.replace(/[()\\]/g, '')}) '`)
      .join(' ')} ET`;
    objs[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objs[pageIds[i]! + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const tools = new CliDocumentTools();
let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tools-test-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const LONG = 'Section 420 cheating and dishonestly inducing delivery of property shall be punished with imprisonment';

describe.skipIf(!binaries)('qpdf + Poppler', () => {
  it('sanitizes a PDF, then reads its text per page and its fonts', async () => {
    const src = join(dir, 'text.pdf');
    const out = join(dir, 'text.clean.pdf');
    await writeFile(src, makePdf([`${LONG} page one`, `${LONG} page two`]));
    await tools.sanitizePdf(src, out);
    const pages = await tools.pdfTextPages(out);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('page one');
    expect(pages[1]).toContain('page two');
    expect(await tools.pdfFontNames(out)).toContain('Helvetica');
  });

  it('reads a real SutonnyMJ gazette and converts it to Unicode (DATA-11)', async () => {
    // First 2 pages of the Bangladesh Investment Development Authority Bill 2016 (dpp.gov.bd gazette 16000).
    const src = join(dir, 'gazette.pdf');
    const out = join(dir, 'gazette.clean.pdf');
    await writeFile(src, await readFile(new URL('./fixtures/gazette-2016-bill-sutonnymj.pdf', import.meta.url)));
    await tools.sanitizePdf(src, out);
    const pages = await tools.pdfTextPages(out);
    const fontNames = await tools.pdfFontNames(out);
    expect(fontNames.some((f) => f.includes('SutonnyMJ'))).toBe(true);
    const text = pages.join('\n');
    expect(looksLikeBijoy({ text, fontNames })).toBe(true);
    const unicode = convertBijoyDocument(text);
    expect(unicode).toContain('কর্তৃপক্ষ কর্তৃক প্রকাশিত');
    expect(unicode).toContain('অর্থনৈতিক কর্মকাণ্ডে ব্যবহারের লক্ষ্যে');
    expect(unicode).toContain('"অনুমোদনপত্র" অর্থ বেসরকারি খাতে কোন শিল্প স্থাপনের বিষয়ে ধারা ১৬ এর');
    expect(unicode).toContain('মূল্য : টাকা ১৫.০০');
    expect(unicode).not.toMatch(/[†‡©¨Ö]/);
  });

  it('removes embedded files', async () => {
    const src = join(dir, 'plain.pdf');
    const att = join(dir, 'with-att.pdf');
    const payload = join(dir, 'payload.exe');
    await writeFile(src, makePdf([LONG]));
    await writeFile(payload, 'MZ fake');
    expect((await run('qpdf', [src, '--add-attachment', payload, '--', att])).code).toBe(0);
    expect((await run('qpdf', ['--list-attachments', att])).stdout.toString()).toContain('payload.exe');
    const out = join(dir, 'att.clean.pdf');
    await tools.sanitizePdf(att, out);
    expect((await run('qpdf', ['--list-attachments', out])).stdout.toString()).not.toContain('payload.exe');
  });

  it('rejects encrypted and broken PDFs with clear codes', async () => {
    const src = join(dir, 'plain2.pdf');
    const enc = join(dir, 'enc.pdf');
    await writeFile(src, makePdf([LONG]));
    expect((await run('qpdf', ['--encrypt', 'user', 'owner', '256', '--', src, enc])).code).toBe(0);
    await expect(tools.sanitizePdf(enc, join(dir, 'x.pdf'))).rejects.toMatchObject({ code: 'PDF_ENCRYPTED' });

    const broken = join(dir, 'broken.pdf');
    await writeFile(broken, '%PDF-1.7\nthis is not a pdf at all\n');
    await expect(tools.sanitizePdf(broken, join(dir, 'y.pdf'))).rejects.toBeInstanceOf(ToolError);
  });

  it('rasterizes pages to PNG, up to the page limit', async () => {
    const src = join(dir, 'three.pdf');
    await writeFile(src, makePdf(['one', 'two', 'three']));
    const pagesDir = await mkdtemp(join(dir, 'pages-'));
    const pngs = await tools.rasterizePdf(src, pagesDir, 72, 2);
    expect(pngs).toHaveLength(2);
    for (const p of pngs) expect([...p.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('sharp and mammoth', () => {
  it('normalizes phone photos: fits 2000 px, greyscale PNG', async () => {
    const photo = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: { r: 200, g: 180, b: 150 } } }).jpeg().toBuffer();
    const out = await tools.normalizeImage(new Uint8Array(photo));
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'png', width: MAX_IMAGE_EDGE, height: 800 });
    expect(meta.channels).toBe(1);
    await expect(tools.normalizeImage(new TextEncoder().encode('not an image'))).rejects.toMatchObject({ code: 'IMAGE_INVALID' });
  });

  it('reads DOCX text', async () => {
    const docx = new Uint8Array(await readFile(new URL('./fixtures/minimal.docx', import.meta.url)));
    expect((await tools.docxText(docx)).trim()).toBe('Test fixture');
    await expect(tools.docxText(new TextEncoder().encode('PK not a zip'))).rejects.toMatchObject({ code: 'DOCX_INVALID' });
  });
});
