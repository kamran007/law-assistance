import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliDocumentTools } from '../src/scan/tools';
import { parseJudgmentHeader } from '../src/scob/pdf-metadata';
import { averageCharsPerPage, cleanPages, markParagraphs, MIN_CHARS_PER_PAGE } from '../src/scob/text';

/**
 * JUD-04 with the real qpdf / Poppler on a published judgment (5 SCOB [2015] HCD 6, 3 pages, saved
 * in the JUD-01 spike). Needs the binaries (worker image, CI); skipped where they are missing, and
 * REQUIRE_DOC_TOOLS (set in CI) turns a missing binary into a failure.
 */
const has = (cmd: string, arg = '-v') => !spawnSync(cmd, [arg], { windowsHide: true }).error;
const binaries = has('qpdf', '--version') && has('pdftotext') && has('pdffonts');
if (process.env.REQUIRE_DOC_TOOLS && !binaries) throw new Error('REQUIRE_DOC_TOOLS is set but qpdf/Poppler are not installed');

describe.skipIf(!binaries)('SCOB judgment PDF with the real tools', () => {
  it('sanitizes, extracts text, reads the header and marks paragraphs', async () => {
    const tools = new CliDocumentTools();
    const dir = await mkdtemp(join(tmpdir(), 'scob-real-'));
    try {
      const raw = join(dir, 'in.pdf');
      const clean = join(dir, 'clean.pdf');
      await writeFile(raw, readFileSync(new URL('./fixtures/scob/5_SCOB_HCD_2.pdf', import.meta.url)));
      await tools.sanitizePdf(raw, clean);
      const pages = await tools.pdfTextPages(clean);
      expect(pages).toHaveLength(3);
      expect(averageCharsPerPage(pages)).toBeGreaterThan(MIN_CHARS_PER_PAGE);

      const header = parseJudgmentHeader(pages.slice(0, 4).join('\n'));
      expect(header).toMatchObject({
        citation: '5 SCOB [2015] HCD',
        parties: 'Md. Shariful Alam Vs Artha Rin Adalat & anr',
        authoringJudge: 'Zubayer Rahman Chowdhury, J',
        decisionDate: '2015-06-18',
        hearingDates: ['2015-06-16'],
        caseNumbers: ['WRIT PETITION NO. 9299 OF 2014'],
      });

      const { text, paragraphs } = markParagraphs(cleanPages(pages));
      expect(paragraphs).toBeGreaterThanOrEqual(4);
      expect(text).toMatch(/^\[para 1\] The instant Rule was issued/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
