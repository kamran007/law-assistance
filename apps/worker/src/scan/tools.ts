import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import mammoth from 'mammoth';
import sharp from 'sharp';

/**
 * File processing for the scan pipeline (TRD §8.2 stages 1–2, §12.6). Interface so the pipeline is
 * testable without the binaries; `CliDocumentTools` needs Poppler (`pdftotext`, `pdftoppm`,
 * `pdffonts`) and `qpdf` on PATH (installed in the worker image).
 */
export interface DocumentTools {
  /** Rewrites a PDF with qpdf; throws ToolError(PDF_ENCRYPTED | PDF_INVALID) for unusable files. */
  sanitizePdf(inPath: string, outPath: string): Promise<void>;
  /** Text per page (pdftotext splits pages with form feeds). */
  pdfTextPages(path: string): Promise<string[]>;
  pdfFontNames(path: string): Promise<string[]>;
  /** PNG pages at `dpi`, at most `maxPages`. */
  rasterizePdf(path: string, outDir: string, dpi: number, maxPages: number): Promise<Uint8Array[]>;
  docxText(bytes: Uint8Array): Promise<string>;
  /** Auto-rotate, fit within 2000 px, greyscale, local contrast (CLAHE): better OCR on phone photos. */
  normalizeImage(bytes: Uint8Array): Promise<Uint8Array>;
}

/** A file problem the user can act on (never retried). `code` reaches the client as processing_error. */
export class ToolError extends Error {
  constructor(
    readonly code: 'PDF_ENCRYPTED' | 'PDF_INVALID' | 'DOCX_INVALID' | 'IMAGE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs a binary without a shell; arguments are file paths and fixed flags, never document text. */
export function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) reject(new Error(`${cmd} killed by ${signal} (timeout ${timeoutMs} ms)`));
      else resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export const MAX_IMAGE_EDGE = 2000;

export class CliDocumentTools implements DocumentTools {
  async sanitizePdf(inPath: string, outPath: string): Promise<void> {
    // qpdf --is-encrypted: exit 0 = encrypted, 2 = not encrypted.
    if ((await run('qpdf', ['--is-encrypted', inPath])).code === 0) {
      throw new ToolError('PDF_ENCRYPTED', 'password-protected PDF');
    }
    const attachments = (await run('qpdf', ['--list-attachments', inPath])).stdout
      .toString()
      .split(/\r?\n/)
      .map((l) => /^(\S.*?) ->/.exec(l)?.[1])
      .filter((k): k is string => !!k);
    // Rewrite through qpdf's parser: drops embedded files, flattens annotations (incl. form and
    // link actions), discards unreferenced objects. Exit 0 = ok, 3 = repaired with warnings.
    const res = await run('qpdf', [
      inPath,
      '--flatten-annotations=all',
      '--remove-unreferenced-resources=yes',
      '--object-streams=generate',
      ...attachments.map((k) => `--remove-attachment=${k}`),
      outPath,
    ]);
    if (res.code !== 0 && res.code !== 3) throw new ToolError('PDF_INVALID', `qpdf exit ${res.code}`);
  }

  async pdfTextPages(path: string): Promise<string[]> {
    const res = await run('pdftotext', ['-enc', 'UTF-8', '-layout', path, '-']);
    if (res.code !== 0) throw new ToolError('PDF_INVALID', `pdftotext exit ${res.code}`);
    const pages = res.stdout.toString('utf8').split('\f');
    if (pages.length > 1 && pages.at(-1)!.trim() === '') pages.pop(); // trailing form feed
    return pages;
  }

  async pdfFontNames(path: string): Promise<string[]> {
    const res = await run('pdffonts', [path]);
    if (res.code !== 0) return [];
    // Header (2 lines), then one font per line; the name is the first column.
    return res.stdout
      .toString()
      .split(/\r?\n/)
      .slice(2)
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter(Boolean);
  }

  async rasterizePdf(path: string, outDir: string, dpi: number, maxPages: number): Promise<Uint8Array[]> {
    const res = await run('pdftoppm', ['-r', String(dpi), '-png', '-f', '1', '-l', String(maxPages), path, join(outDir, 'page')], 180_000);
    if (res.code !== 0) throw new ToolError('PDF_INVALID', `pdftoppm exit ${res.code}`);
    const files = (await readdir(outDir)).filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => pageNo(a) - pageNo(b));
    return Promise.all(files.map(async (f) => new Uint8Array(await readFile(join(outDir, f)))));
  }

  async docxText(bytes: Uint8Array): Promise<string> {
    try {
      return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
    } catch {
      throw new ToolError('DOCX_INVALID', 'unreadable DOCX');
    }
  }

  async normalizeImage(bytes: Uint8Array): Promise<Uint8Array> {
    try {
      const out = await sharp(bytes, { limitInputPixels: 100_000_000 })
        .rotate()
        .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
        .greyscale()
        .clahe({ width: 64, height: 64 })
        .toColourspace('b-w') // one channel: a third of the bytes sent to OCR
        .png()
        .toBuffer();
      return new Uint8Array(out);
    } catch {
      throw new ToolError('IMAGE_INVALID', 'unreadable image');
    }
  }
}

const pageNo = (f: string) => Number(/(\d+)\.png$/.exec(f)?.[1] ?? 0);
