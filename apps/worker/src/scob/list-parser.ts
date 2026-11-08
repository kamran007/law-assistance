import * as cheerio from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { SCOB_SOURCE_CONFIG as cfg, divisionOf, type Division } from './source-config';

/** One issue on the SCOB index (SRS §4.4). */
export interface ScobIssue {
  issue: number;
  year: number | null;
  issuePdfUrl: string | null;
  lists: Partial<Record<Division, string>>;
}

/** One row of a division list: what the list publishes about a judgment. */
export interface ScobListRow {
  issue: number;
  division: Division;
  serial: number;
  parties: string;
  /** "(Syed Refaat Ahmed, CJ)" on the newer template; the older one doesn't list it (take it from the PDF). */
  authoringJudge: string | null;
  /** As published, whitespace normalised: "20 SCOB [2025] AD", "5 SCOB[2015]AD 1". */
  citation: string | null;
  /** Older rows that list only the case number (issue 1); parties and citation then come from the PDF. */
  caseNumber: string | null;
  keyWords: string;
  /** Newer template only. */
  summary: string | null;
  keyRatio: string;
  /** "(Para26 & 27)" → ["26", "27"]; empty when the list gives none (older template). */
  keyRatioParagraphs: string[];
  pdfUrl: string;
}

const abs = (href: string) => new URL(href.replace(/&amp;/g, '&'), cfg.baseUrl).toString();

/** Text with paragraph and line breaks kept as "\n", runs of spaces collapsed. */
function blockText($: cheerio.CheerioAPI, el: Cheerio<AnyNode>): string {
  const clone = el.clone();
  clone.find('br').replaceWith('\n');
  clone.find('p, div, li').each((_, n) => {
    $(n).append('\n');
  });
  return clone
    .text()
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t\r]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const CITATION = /\d+\s*SCOB\s*\[\s*\d{4}\s*\]\s*(?:AD|HCD|HD)(?:\s*\d+)?/i;
const normCitation = (s: string) => oneLine(s);
/**
 * "CIVIL APPEAL NO.73 OF 2012", "JAIL PETITION NOS.18 OF 2008, …" (issue 1 lists these instead of
 * parties). Three simple checks instead of one backtracking pattern over the whole cell.
 */
const isCaseNumberOnly = (s: string) => /^(?:CIVIL|CRIMINAL|JAIL|WRIT|DEATH|FIRST|REVIEW)\b/i.test(s) && /\bNOS?\.?\s?\d/i.test(s) && /\bOF\s\d{4}\b/i.test(s) && !/\bVs?\.?\s/i.test(s);
const JUDGE_AT_END = /\(([^()]*?,\s*(?:CJ|J|JJ)\.?)\)\s*$/;

/** "(Para93)", "(Para26 & 27)", "(Para 13)", "(Paras 10-12)" → paragraph numbers. */
export function ratioParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\(\s*paras?\.?\s*([0-9][0-9\s,&and–-]*)\)/gi)) {
    const body = m[1]!;
    for (const part of body.split(/\s*(?:,|&|and)\s*/i)) {
      const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part.trim());
      if (range) {
        const [a, b] = [Number(range[1]), Number(range[2])];
        if (b >= a && b - a < 50) for (let n = a; n <= b; n++) out.push(String(n));
      } else if (/^\d+$/.test(part.trim())) out.push(part.trim());
    }
  }
  return [...new Set(out)];
}

/** Issues and their division list URLs from the index page. */
export function parseIndex(html: string): ScobIssue[] {
  const $ = cheerio.load(html);
  const issues = new Map<number, ScobIssue>();
  const get = (n: number) => issues.get(n) ?? issues.set(n, { issue: n, year: null, issuePdfUrl: null, lists: {} }).get(n)!;
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href')!;
    const list = cfg.listLinkPattern.exec(href);
    if (list) get(Number(list[2])).lists[divisionOf(list[1]!)] = abs(href);
    const pdf = cfg.issuePdfPattern.exec(href);
    if (pdf) Object.assign(get(Number(pdf[1])), { year: Number(pdf[2]), issuePdfUrl: abs(href) });
  });
  return [...issues.values()].sort((x, y) => x.issue - y.issue);
}

/**
 * Rows of a division list. Two templates (JUD-01):
 * - newer (issue 15+): 4 cells — serial | parties (link), (judge), citation, "Key Words:" … | summary | key ratio
 * - older (issues 1–14): 6 cells — serial | issue | year | parties + citation (link) | key words | short ratio
 * Rows without a judgment PDF link are skipped.
 */
export function parseDivisionList(html: string, ctx: { issue: number; division: Division }): ScobListRow[] {
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- every regex in this parser is linear (no nested quantifiers; case numbers use three separate checks) and runs on single table cells
  const $ = cheerio.load(html);
  const rows: ScobListRow[] = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    const serial = /^(\d+)\.?$/.exec(oneLine(tds.first().text()));
    if (!serial) return;
    const link = $(tr).find('a[href]').filter((_, a) => cfg.judgmentPdfHref.test($(a).attr('href') ?? '')).first();
    if (!link.length) return;
    const pdfUrl = abs(link.attr('href')!);

    if (tds.length >= 6) {
      // Older template.
      const linkText = oneLine(link.text());
      const citation = CITATION.exec(linkText)?.[0] ?? null;
      const keyRatio = blockText($, tds.eq(5));
      let parties = oneLine(citation ? linkText.slice(0, linkText.indexOf(citation)) : linkText);
      // Issue 1 (and a few later rows) list the case number instead of parties and citation;
      // parties and citation then come from the PDF.
      const caseNumber = !citation && isCaseNumberOnly(parties) ? parties.replace(/\.$/, '') : null;
      if (caseNumber) parties = '';
      // Some older rows end the parties with the authoring judge: "… Vs. Bangladesh and ors (Zinat Ara, J)".
      const judgeAtEnd = JUDGE_AT_END.exec(parties);
      if (judgeAtEnd) parties = parties.slice(0, judgeAtEnd.index).trim();
      rows.push({
        ...ctx,
        serial: Number(serial[1]),
        parties,
        caseNumber,
        authoringJudge: judgeAtEnd ? oneLine(judgeAtEnd[1]!) : null,
        citation: citation && normCitation(citation),
        keyWords: blockText($, tds.eq(4)),
        summary: null,
        keyRatio,
        keyRatioParagraphs: ratioParagraphs(keyRatio),
        pdfUrl,
      });
      return;
    }
    if (tds.length >= 4) {
      const cell = tds.eq(1);
      const text = blockText($, cell);
      const judge = /\(([^()]*?,\s*(?:CJ|J|JJ)\.?)\)/.exec(text)?.[1] ?? null;
      const citation = CITATION.exec(text)?.[0] ?? null;
      const kw = /key\s*words?\s*:\s*([\s\S]*)$/i.exec(text)?.[1] ?? '';
      const keyRatio = blockText($, tds.eq(3));
      rows.push({
        ...ctx,
        serial: Number(serial[1]),
        parties: oneLine(link.text()),
        caseNumber: null,
        authoringJudge: judge && oneLine(judge),
        citation: citation && normCitation(citation),
        keyWords: oneLine(kw),
        summary: blockText($, tds.eq(2)) || null,
        keyRatio,
        keyRatioParagraphs: ratioParagraphs(keyRatio),
        pdfUrl,
      });
    }
  });
  return rows;
}
