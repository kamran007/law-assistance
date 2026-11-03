import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashSectionContent } from '@lawassist/legal-text';
import { extractActIds } from '../src/scrape/discover';
import { parseActPrint } from '../src/scrape/parser';
import { DEFAULT_SOURCE_CONFIG as cfg } from '../src/scrape/source-config';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const meta = { bdlawsActId: 11, sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-11.html' };

describe('parseActPrint: English pre-1987 Act', () => {
  const act = parseActPrint(fixture('act-print-en.html'), meta, cfg);

  it('reads Act metadata', () => {
    expect(act.title).toBe('THE PENAL CODE, 1860');
    expect(act.actNumber).toBe('ACT NO. XLV OF 1860');
    expect(act.enactedDate).toBe('1860-10-06');
    expect(act.language).toBe('EN');
    expect(act.isRepealed).toBe(false);
    expect(act.warnings).toEqual([]);
  });

  it('parses every section in document order with chapter references', () => {
    expect(act.sections.map((s) => s.normalizedSectionKey)).toEqual(['415', '420', '326A', '341', '342']);
    expect(act.sections[1]!.chapterReference).toBe('CHAPTER XVII OF OFFENCES AGAINST PROPERTY');
    expect(act.sections[2]!.chapterReference).toBe('CHAPTER XVI OF OFFENCES AFFECTING THE HUMAN BODY');
    expect(act.sections[1]!.marginalHeading).toBe('Cheating and dishonestly inducing delivery of property');
  });

  it('keeps the display text verbatim (markers included) with one line per paragraph', () => {
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

  it('attaches parsed amendment footnotes to the sections that reference them', () => {
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

    const renumbered = fixture('act-print-en.html').replaceAll('<sup>2</sup>', '<sup>7</sup>');
    const again = parseActPrint(renumbered, meta, cfg);
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
    const broken = parseActPrint('<html><body><div class="lineremove"><div class="txt-details"><p>no number here</p></div></div></body></html>', meta, cfg);
    expect(broken.sections).toEqual([]);
    expect(broken.warnings).toEqual(expect.arrayContaining(['title not found', 'section block #0: no section number', 'no sections parsed']));
  });

  it('recognises a repealed Act', () => {
    const html = '<h3 class="act-title">THE BENGAL ACT, 1870 [Repealed]</h3>';
    expect(parseActPrint(html, meta, cfg).isRepealed).toBe(true);
  });
});

describe('parseActPrint: Bangla post-1987 Act', () => {
  const act = parseActPrint(fixture('act-print-bn.html'), { ...meta, bdlawsActId: 835 }, cfg);

  it('reads Bangla metadata and digits', () => {
    expect(act.language).toBe('BN');
    expect(act.enactedDate).toBe('2000-02-14');
    expect(act.actNumber).toBe('2000 সনের 8 নং আইন');
    expect(act.warnings).toEqual([]);
  });

  it('parses Bangla section numbers (danda terminator, inserted letter)', () => {
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
});
