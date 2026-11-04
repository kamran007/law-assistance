import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hashSectionContent } from '@lawassist/legal-text';
import { extractActIds } from '../src/scrape/discover';
import { decodeBody } from '../src/scrape/http-client';
import { parseActPrint, type ParsedAct } from '../src/scrape/parser';
import { DEFAULT_SOURCE_CONFIG as cfg } from '../src/scrape/source-config';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const realBytes = (name: string) => gunzipSync(readFileSync(new URL(`./fixtures/bdlaws/${name}`, import.meta.url)));
const meta = { bdlawsActId: 11, sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-11.html' };

/** The second Bangla terminator bdlaws uses ("১৷"); looks like the danda but is U+09F7. */
const BN_DANDA_LOOKALIKE = String.fromCodePoint(0x09f7);

describe('parseActPrint: English pre-1987 Act (fixture in the real markup)', () => {
  const act = parseActPrint(fixture('act-print-en.html'), meta, cfg);

  it('reads Act metadata from the title block and publish date', () => {
    expect(act.title).toBe('THE PENAL CODE, 1860');
    expect(act.actNumber).toBe('ACT NO. XLV OF 1860');
    expect(act.enactedDate).toBe('1860-10-06');
    expect(act.language).toBe('EN');
    expect(act.isRepealed).toBe(false);
    expect(act.warnings).toEqual([]);
  });

  it('parses every section in document order; skips the Preamble and empty rows', () => {
    expect(act.sections.map((s) => s.normalizedSectionKey)).toEqual(['415', '420', '326A', '341', '342']);
    expect(act.sections[1]!.marginalHeading).toBe('Cheating and dishonestly inducing delivery of property');
  });

  it('takes the chapter from the group nested in the chapter’s first row', () => {
    expect(act.sections.map((s) => s.chapterReference)).toEqual([
      'CHAPTER XVII OF OFFENCES AGAINST PROPERTY',
      'CHAPTER XVII OF OFFENCES AGAINST PROPERTY',
      'CHAPTER XVI OF OFFENCES AFFECTING THE HUMAN BODY',
      'CHAPTER XVI OF OFFENCES AFFECTING THE HUMAN BODY',
      'CHAPTER XVI OF OFFENCES AFFECTING THE HUMAN BODY',
    ]);
  });

  it('keeps the display text verbatim (markers included), one line per clbr-separated paragraph', () => {
    const s326a = act.sections[2]!;
    expect(s326a.sectionNumber).toBe('326A');
    expect(s326a.contentBody.split('\n')).toHaveLength(3);
    expect(s326a.contentBody.startsWith('1[326A. (1) Whoever')).toBe(true);
  });

  it('splits sub-sections, provisos, explanations and illustrations', () => {
    expect(act.sections[2]!.parts.map((p) => [p.kind, p.label])).toEqual([
      ['SUBSECTION', '(1)'],
      ['SUBSECTION', '(2)'],
      ['PROVISO', null],
    ]);
    expect(act.sections[0]!.parts.map((p) => p.kind)).toEqual(['TEXT', 'EXPLANATION', 'ILLUSTRATION', 'TEXT']); // "(a)" is an illustration item, not a sub-section
  });

  it('attaches parsed amendment footnotes from the footnote list to the sections that reference them', () => {
    expect(act.sections[2]!.footnotes).toEqual([
      expect.objectContaining({ action: 'INSERTED', byAct: 'Act No. XXIV of 1984', date: '1984-07-01' }),
    ]);
    expect(act.sections[3]!.footnotes).toEqual([
      expect.objectContaining({ action: 'SUBSTITUTED', byAct: 'Ordinance No. X of 1982', date: null }),
    ]);
    expect(act.sections[4]!.footnotes).toEqual([]);
  });

  it('hashes without footnote markers, so renumbering footnotes does not create a version', () => {
    const s341 = act.sections[3]!;
    const bodyWithoutMarker = s341.contentBody.replace('2[five', '[five');
    expect(s341.contentHash).toBe(hashSectionContent(s341.marginalHeading!, bodyWithoutMarker));

    const renumbered = fixture('act-print-en.html')
      .replaceAll(`<a href='2' >2</a>`, `<a href='7' >7</a>`)
      .replaceAll(`<sup class='en'>2</sup>`, `<sup class='en'>7</sup>`);
    const again = parseActPrint(renumbered, meta, cfg);
    expect(again.warnings).toEqual([]);
    expect(again.sections[3]!.contentHash).toBe(s341.contentHash);
  });

  it('is deterministic and detects a one-word amendment', () => {
    const html = fixture('act-print-en.html');
    const a = parseActPrint(html, meta, cfg);
    const b = parseActPrint(html.replace('seven years', 'ten years'), meta, cfg);
    expect(a.sections.map((s) => s.contentHash)).toEqual(act.sections.map((s) => s.contentHash));
    const changed = b.sections.filter((s, i) => s.contentHash !== a.sections[i]!.contentHash);
    expect(changed.map((s) => s.normalizedSectionKey)).toEqual(['420']);
  });

  it('reports structural problems as warnings instead of guessing', () => {
    const broken = parseActPrint(
      '<html><body><div class="row lineremoves"><div class="txt-head">Odd</div><div class="txt-details">no number here</div></div></body></html>',
      meta,
      cfg,
    );
    expect(broken.sections).toEqual([]);
    expect(broken.warnings).toEqual(expect.arrayContaining(['title not found', 'section block #0: no section number', 'no sections parsed']));
  });

  it('recognises a repealed Act from the row classes, or from the title text', () => {
    const rows = '<div class="row lineremoves repealed"><div class="txt-head">Short title</div><div class="txt-details">1. This Act may be called the Old Act.</div></div>';
    expect(parseActPrint(rows, meta, cfg).isRepealed).toBe(true);
    const title = '<section class="bg-act-section"><h3>THE BENGAL ACT, 1870 [Repealed]</h3></section>';
    expect(parseActPrint(title, meta, cfg).isRepealed).toBe(true);
  });
});

describe('parseActPrint: section rows the portal splits or numbers unusually', () => {
  const row = (head: string, body: string) =>
    `<div class="row lineremoves "><div class="col-sm-3 txt-head">${head}</div><div class="col-sm-9 txt-details">${body}</div></div>`;
  const parse = (rows: string[]) => parseActPrint(`<section class="bg-act-section"><h3>T</h3></section>${rows.join('')}`, meta, cfg);

  it('appends a row without a number to the section above, with its note in the hash', () => {
    const act = parse([row('Hearsay', '32. Statements are relevant in the following cases:-'), row('or is made in course of business;', '(2) When the statement was made in the ordinary course of business.')]);
    expect(act.warnings).toEqual([]);
    expect(act.sections).toHaveLength(1);
    expect(act.sections[0]!.marginalHeading).toBe('Hearsay');
    expect(act.sections[0]!.contentBody.split('\n')).toEqual([
      '32. Statements are relevant in the following cases:-',
      '(2) When the statement was made in the ordinary course of business.',
    ]);
    const editedNote = parse([row('Hearsay', '32. Statements are relevant in the following cases:-'), row('or is made in a will;', '(2) When the statement was made in the ordinary course of business.')]);
    expect(editedNote.sections[0]!.contentHash).not.toBe(act.sections[0]!.contentHash);
  });

  it('reads "171-I." as 171I, not as a second section 171', () => {
    const act = parse([row('a', '171. Whoever wears a garb.'), row('b', '171-I. Whoever fails to keep accounts.')]);
    expect(act.sections.map((s) => [s.sectionNumber, s.normalizedSectionKey])).toEqual([
      ['171', '171'],
      ['171-I', '171I'],
    ]);
    expect(act.warnings).toEqual([]);
  });

  it('expands "23 and 24." and "100-103." rows into one entry per spent section', () => {
    const act = parse([row('Repealed', '23 and 24. [Repealed by Act No. XII of 1923.]'), row('[Omitted]', '100-103. [Omitted by Ordinance No. XLIX of 1978.]')]);
    expect(act.sections.map((s) => s.normalizedSectionKey)).toEqual(['23', '24', '100', '101', '102', '103']);
    expect(act.sections[1]!.contentBody).toBe('23 and 24. [Repealed by Act No. XII of 1923.]');
  });

  it('starts a new section after a stray marginal note line, but only for a later, unseen number', () => {
    const act = parse([
      row('“Drawer”', '7. The maker of a bill of exchange is called the “drawer”.'),
      row('“Holder”', '“Payee”<div class="clbr"></div>8. The “holder” of a promissory note means the payee.'),
      row('Note', 'Short line<div class="clbr"></div>5. A cross-reference, not a new section.'),
    ]);
    expect(act.sections.map((s) => s.normalizedSectionKey)).toEqual(['7', '8']);
    // The stray "“Payee”" line is not in any body; the earlier number "5." stays a continuation of s.8.
    expect(act.sections[1]!.contentBody.split('\n')).toEqual([
      '8. The “holder” of a promissory note means the payee.',
      'Short line',
      '5. A cross-reference, not a new section.',
    ]);
    expect(act.sections.map((s) => s.contentBody).join('\n')).not.toContain('“Payee”');
  });

  it('accepts both Bangla terminators: the danda and U+09F7', () => {
    const act = parse([row('ক', '১। প্রথম ধারা।'), row('খ', `২${BN_DANDA_LOOKALIKE} দ্বিতীয় ধারা।`)]);
    expect(act.sections.map((s) => s.normalizedSectionKey)).toEqual(['1', '2']);
    expect(act.sections[1]!.parts[0]!.text).toBe('দ্বিতীয় ধারা।');
  });
});

describe('parseActPrint: Bangla post-1987 Act (fixture in the real markup)', () => {
  const act = parseActPrint(fixture('act-print-bn.html'), { ...meta, bdlawsActId: 835 }, cfg);

  it('reads Bangla metadata and digits', () => {
    expect(act.title).toBe('নারী ও শিশু নির্যাতন দমন আইন, ২০০০');
    expect(act.language).toBe('BN');
    expect(act.enactedDate).toBe('2000-02-14');
    expect(act.actNumber).toBe('2000 সনের 8 নং আইন');
    expect(act.warnings).toEqual([]);
  });

  it('parses Bangla section numbers (danda terminator, inserted letter) from <p> paragraphs', () => {
    expect(act.sections.map((s) => [s.sectionNumber, s.normalizedSectionKey])).toEqual([
      ['৯', '9'],
      ['১১ক', '11A'],
    ]);
    expect(act.sections[0]!.parts.map((p) => [p.kind, p.label])).toEqual([
      ['SUBSECTION', '(১)'],
      ['EXPLANATION', null],
    ]);
    expect(act.sections[1]!.parts[1]!.kind).toBe('PROVISO');
  });

  it('parses Bangla footnotes with Bangla-digit markers', () => {
    expect(act.sections[1]!.footnotes).toEqual([expect.objectContaining({ action: 'INSERTED', byAct: 'Act No. 30 of 2003' })]);
  });
});

/**
 * Regression over real print views saved in the DATA-01 spike (2026-11-04). Counts are what the
 * parser produced after manual checks; a change means the parser (or a fixture) changed behaviour.
 */
describe('parseActPrint: real bdlaws snapshots', () => {
  const parsed = new Map<number, ParsedAct>();
  const real = (id: number): ParsedAct => {
    if (!parsed.has(id)) {
      const html = realBytes(`act-print-${id}.html.gz`).toString('utf8');
      parsed.set(id, parseActPrint(html, { bdlawsActId: id, sourceUrl: `http://bdlaws.minlaw.gov.bd/act-print-${id}.html` }, cfg));
    }
    return parsed.get(id)!;
  };
  const section = (id: number, key: string) => real(id).sections.find((s) => s.normalizedSectionKey === key);

  it.each([
    // id, title, act number, enacted, language, repealed, sections
    [11, 'The Penal Code, 1860', 'ACT NO. XLV OF 1860', '1860-10-06', 'EN', false, 558],
    [75, 'The Code of Criminal Procedure, 1898', 'ACT NO. V OF 1898', '1898-03-22', 'EN', false, 523],
    [24, 'The Evidence Act, 1872', 'ACT NO. I OF 1872', '1872-03-15', 'EN', false, 182],
    [86, 'The Code of Civil Procedure, 1908', 'ACT NO. V OF 1908', '1908-03-21', 'EN', false, 171],
    [46, 'The Negotiable Instruments Act, 1881', 'ACT NO. XXVI OF 1881', '1881-12-09', 'EN', false, 172],
    [835, 'নারী ও শিশু নির্যাতন দমন আইন, ২০০০', '2000 সনের 8 নং আইন', '2000-02-14', 'BN', false, 42],
    [1276, 'মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮', '2018 সনের 63 নং আইন', '2018-11-14', 'BN', false, 78],
    [1457, 'সাইবার নিরাপত্তা আইন, ২০২৩', '2023 সনের 39 নং আইন', '2023-09-18', 'BN', true, 60],
    [16, 'The Public Gambling Act, 1867', 'ACT NO. II OF 1867', '1867-04-10', 'EN', true, 18],
  ] as const)('Act %i: %s', (id, title, actNumber, enactedDate, language, isRepealed, count) => {
    const act = real(id);
    expect(act).toMatchObject({ title, actNumber, enactedDate, language, isRepealed });
    expect(act.sections).toHaveLength(count);
    // The only warning: CrPC s.88 points to footnote 107, which the portal's footnote list lacks.
    expect(act.warnings).toEqual(id === 75 ? ['section 88: footnote 107 referenced but not found'] : []);
  });

  it('keeps continuation rows with their section (Evidence Act s.32 has eight numbered cases)', () => {
    const s32 = section(24, '32')!;
    expect(s32.contentBody).toContain('(8) When the statement was made by a number of persons');
    expect(s32.parts.filter((p) => p.kind === 'SUBSECTION').map((p) => p.label)).toEqual(['(1)', '(2)', '(3)', '(4)', '(5)', '(6)', '(7)', '(8)']);
  });

  it('handles hyphen letters, ranges and stray notes the way the synthetic tests expect', () => {
    expect(section(11, '171I')?.contentBody).toMatch(/^171-I\. Whoever/);
    expect(section(75, '265I')?.marginalHeading).toBe('Entering upon defence');
    expect(section(75, '24')?.contentBody).toMatch(/^23 and 24\. \[Repealed/);
    expect(section(86, '102')?.contentBody).toMatch(/^100-103\. \[Omitted/);
    expect(section(46, '8')?.contentBody).toMatch(/^8\. The “holder”/);
    expect(section(46, '131')?.marginalHeading).toBe('Non-liability of banker receiving payment of cheque');
  });

  it('assigns chapters and footnotes', () => {
    expect(section(11, '420')).toMatchObject({ chapterReference: 'Chapter XVII OF OFFENCES AGAINST PROPERTY', marginalHeading: 'Cheating and dishonestly inducing deliver of property' });
    expect(section(11, '1')!.footnotes).toEqual([expect.objectContaining({ action: 'SUBSTITUTED' })]);
    expect(real(75).sections.filter((s) => s.footnotes.some((f) => f.date)).length).toBeGreaterThan(100);
  });
});

describe('extractActIds', () => {
  it('collects unique act ids from index links in all URL shapes', () => {
    const html = `
      <a href="act-11.html">Penal Code</a>
      <a href="http://bdlaws.minlaw.gov.bd/act-details-75.html">CrPC</a>
      <a href="/act-print-11.html">print</a>
      <a href="laws-of-bangladesh.html">index</a>
      <a href="act-0.html">bad</a>`;
    expect(extractActIds(html, cfg)).toEqual([11, 75]);
  });

  it('finds every Act on the real chronological index (served as UTF-16)', () => {
    const html = decodeBody(realBytes('chronological-index.utf16.html.gz'), 'text/html;charset=UTF-16');
    const ids = extractActIds(html, cfg);
    expect(ids).toHaveLength(1685);
    expect(ids).toEqual(expect.arrayContaining([11, 16, 24, 46, 75, 86, 835, 1276, 1457]));
  });
});
