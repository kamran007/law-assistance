import { judgments, judgmentStatuteRefs, newId, outboxEvents, statutes, statuteSections, type Db } from '@lawassist/db';
import { detectSections, findActMentions, type ActMention, type DetectedAct } from '@lawassist/legal-text';
import { and, asc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { Log } from '../scrape/run-scrape';

/**
 * Statute links for a judgment (TRD §6A.3 step 6; JUD-05). The §8.4 section detector and Act
 * dictionary run over the list's key words and the `[para n]` body. An Act the dictionary doesn't
 * know is kept by the name written next to the citation ("section 63 of the Bangladesh
 * Telecommunication Regulation Act, 2001") and matched against `statutes.title_en`. A link gets a
 * `statute_id` only when that section exists in `statute_sections`; everything else is kept with
 * `statute_id = NULL` and the text as written, so a later relink (more Acts scraped) can resolve it.
 */
export type RefSource = 'KEY_WORDS' | 'BODY';

export interface FoundRef {
  act: DetectedAct | null;
  /** English Act name written next to the citation when the dictionary has none ("Bangladesh Telecommunication Regulation Act, 2001"). */
  actName: string | null;
  sectionKey: string;
  /** First occurrence as written, with the Act name when it was found next to it. */
  raw: string;
  /** Paragraphs ("12") the section is cited in; empty for key words. */
  paragraphs: string[];
  foundIn: RefSource;
}

export interface ResolvedRef extends FoundRef {
  statuteId: string | null;
}

const MAX_RAW = 300;
const WINDOW = 120;
/**
 * An English Act name: capitalised words, an Act word, an optional year ("Bangladesh
 * Telecommunication Regulation Act, 2001", "Abandoned Buildings (Supplementary Provisions)
 * Ordinance, 1985", "Artha Rin Adalat Ain 2003"). At least one word before the Act word, so
 * "Order 20, Rule 18" is not a name. `ws` is the space allowed between words: after a citation a
 * name may wrap onto the next line; before one it may not (it would swallow the previous line).
 */
const name = (ws: string) =>
  String.raw`(?:\(?[A-Z][\w'()&.-]*${ws}(?:(?:of|and|&|the|O)${ws})?){1,8}(?:Act|Ain|Ordinance|Code|Order|Rules|Regulations?)\b(?:,?[ \t]*(?:\d{4}|[০-৯]{4}))?`;
const SEPARATORS = String.raw`[\s,:;—–]`;
// The regexes below run on slices of at most WINDOW (120) characters next to a citation.
/** What may sit between a citation and an Act named after it: left-over sub-parts ",(2)", then "of the". */
const CONNECTOR_AFTER = /^(?:\s?,?\s?\(\s?[0-9A-Za-z]{1,4}\s?\))*[\s,]*((?:of|under|r\/w|read\s+with)\s+)?(?:the\s+)?/i;
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const NAME_AT_START = new RegExp(`^${name(String.raw`(?:[ \t]+\n?|\n)[ \t]*`)}`);
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const NAME_AT_END = new RegExp(`(${name(String.raw`[ \t]+`)})(${SEPARATORS}*)$`);
/** What may sit between an Act named before a citation and the citation: a year, "এর", "'s", separators. */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const GAP_BEFORE = new RegExp(String.raw`^${SEPARATORS}*(?:\(?(?:\d{4}|[০-৯]{4})\)?)?${SEPARATORS}*(?:আইন[^\n;]{0,40}?)?(?:এর|র|ের|'s)?${SEPARATORS}*$`, 'u');
/**
 * An Act named before a citation across a line break or ";" counts only if it opens its key-word
 * entry ("Penal Code, 1860 ↵ Section 302"). In "Section 109 of the Penal Code, 1860; Section 5(1) of
 * …" the Penal Code belongs to the previous citation.
 */
const opensEntry = (text: string, actStart: number, gap: string) => !/[;\n]/.test(gap) || /(?:^|[;\n])[ \t]*(?:the[ \t]+)?$/i.test(text.slice(Math.max(0, actStart - 20), actStart));

interface ActChoice {
  act: DetectedAct | null;
  actName: string | null;
  /** Span of citation + Act name, for the raw text. */
  from: number;
  to: number;
}

const detected = (m: ActMention): DetectedAct => ({ key: m.act.key, bdlawsActId: m.act.bdlawsActId, name: m.act.name });

/**
 * The Act of a citation, by adjacency only. The FIR detector takes the nearest Act within 80
 * characters, which in a key-word list ("Section 5 of the Prevention of Corruption Act, 1947;"
 * after "Penal Code, 1860;") picks the wrong one. Here: an Act written right after ("of the …")
 * wins, else one written right before ("Evidence Act, 1872 ↵ Section 57", "দণ্ডবিধির ৩০২"), else none.
 */
function actFor(text: string, start: number, end: number, mentions: ActMention[]): ActChoice {
  const after = text.slice(end, end + WINDOW);
  const conn = CONNECTOR_AFTER.exec(after)!;
  const at = end + conn[0].length;
  const dictAfter = mentions.find((m) => m.start === at);
  if (dictAfter) return { act: detected(dictAfter), actName: null, from: start, to: dictAfter.end };
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- input is at most WINDOW (120) chars
  const nameAfter = conn[1] || conn[0].includes(',') ? NAME_AT_START.exec(text.slice(at, at + WINDOW)) : null;
  if (nameAfter) return { act: null, actName: nameAfter[0], from: start, to: at + nameAfter[0].length };

  const dictBefore = mentions.filter((m) => m.end <= start && start - m.end <= WINDOW).at(-1);
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- input is at most WINDOW (120) chars
  if (dictBefore) {
    const gap = text.slice(dictBefore.end, start);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- input is at most WINDOW (120) chars
    if (GAP_BEFORE.test(gap) && opensEntry(text, dictBefore.start, gap)) return { act: detected(dictBefore), actName: null, from: dictBefore.start, to: end };
  }
  const before = text.slice(Math.max(0, start - WINDOW), start);
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- input is at most WINDOW (120) chars
  const nameBefore = NAME_AT_END.exec(before);
  if (nameBefore) {
    const nameStart = start - before.length + nameBefore.index;
    if (opensEntry(text, nameStart, nameBefore[2]!)) return { act: null, actName: nameBefore[1]!, from: nameStart, to: end };
  }
  return { act: null, actName: null, from: start, to: end };
}

/** Positions of the `[para n]` markers, in order. */
function paragraphMarks(text: string): { pos: number; n: string }[] {
  return [...text.matchAll(/^\[para (\d+)\]/gm)].map((m) => ({ pos: m.index, n: m[1]! }));
}

function paragraphAt(marks: { pos: number; n: string }[], pos: number): string | null {
  let lo = 0;
  let hi = marks.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid]!.pos <= pos) {
      found = marks[mid]!.n;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** "The Bangladesh Telecommunication Regulation Act, 2001" → "bangladesh telecommunication regulation act 2001". */
export const normalizeActName = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const withoutYear = (s: string) => s.replace(/\s+\d{4}$/, '');

function scan(input: string, foundIn: RefSource): FoundRef[] {
  const text = input.normalize('NFC'); // detector positions refer to the NFC text
  const marks = foundIn === 'BODY' ? paragraphMarks(text) : [];
  const mentions = findActMentions(text);
  const out: FoundRef[] = [];
  for (const c of detectSections(text)) {
    const choice = actFor(text, c.start, c.end, mentions);
    const raw = text.slice(choice.from, choice.to).replace(/\s+/g, ' ').trim().slice(0, MAX_RAW);
    const para = foundIn === 'BODY' ? paragraphAt(marks, c.start) : null;
    const actName = choice.actName?.replace(/\s+/g, ' ').replace(/^the\s+/i, '').trim() ?? null;
    out.push({ act: choice.act, actName, sectionKey: c.key, raw, paragraphs: para ? [para] : [], foundIn });
  }
  return out;
}

/** Every cited section, one entry per (Act, section, where found), paragraphs merged. */
export function findStatuteRefs(keyWords: string, fullText: string | null): FoundRef[] {
  const grouped = new Map<string, FoundRef>();
  for (const ref of [...scan(keyWords, 'KEY_WORDS'), ...(fullText ? scan(fullText, 'BODY') : [])]) {
    const actId = ref.act?.key ?? (ref.actName ? `name:${normalizeActName(ref.actName)}` : '-');
    const k = `${actId}|${ref.sectionKey}|${ref.foundIn}`;
    const seen = grouped.get(k);
    if (!seen) grouped.set(k, { ...ref, paragraphs: [...ref.paragraphs] });
    else for (const p of ref.paragraphs) if (!seen.paragraphs.includes(p)) seen.paragraphs.push(p);
  }
  return [...grouped.values()];
}

/**
 * Resolves Acts to `statutes` rows (dictionary → bdlaws id; otherwise the English title, with the
 * year if one was written, unique without it) and keeps a `statute_id` only for sections that
 * exist. One instance can be reused across judgments (the title list is loaded once).
 */
export class StatuteLinker {
  private titles?: Promise<{ statuteId: string; bdlawsActId: number; name: string }[]>;

  constructor(private readonly db: Db) {}

  private loadTitles() {
    this.titles ??= this.db
      .select({ statuteId: statutes.statuteId, bdlawsActId: statutes.bdlawsActId, titleEn: statutes.titleEn })
      .from(statutes)
      .then((rows) => rows.filter((r) => r.titleEn).map((r) => ({ statuteId: r.statuteId, bdlawsActId: r.bdlawsActId, name: normalizeActName(r.titleEn!) })));
    return this.titles;
  }

  private async statuteFor(ref: FoundRef): Promise<string | null> {
    const titles = await this.loadTitles();
    if (ref.act) return titles.find((t) => t.bdlawsActId === ref.act!.bdlawsActId)?.statuteId ?? (await this.byActId(ref.act.bdlawsActId));
    if (!ref.actName) return null;
    const name = normalizeActName(ref.actName);
    const exact = titles.find((t) => t.name === name);
    if (exact) return exact.statuteId;
    if (/\d{4}$/.test(name)) return null; // year written and it doesn't match: a different Act
    const loose = titles.filter((t) => withoutYear(t.name) === name);
    return loose.length === 1 ? loose[0]!.statuteId : null;
  }

  /** Statutes without an English title are not in the title list. */
  private async byActId(bdlawsActId: number): Promise<string | null> {
    const [row] = await this.db.select({ statuteId: statutes.statuteId }).from(statutes).where(eq(statutes.bdlawsActId, bdlawsActId)).limit(1);
    return row?.statuteId ?? null;
  }

  async resolve(refs: FoundRef[]): Promise<ResolvedRef[]> {
    const withStatute = await Promise.all(refs.map(async (r) => ({ ref: r, statuteId: await this.statuteFor(r) })));
    const statuteIds = [...new Set(withStatute.map((r) => r.statuteId).filter((id): id is string => !!id))];
    const keys = [...new Set(withStatute.filter((r) => r.statuteId).map((r) => r.ref.sectionKey))];
    const existing = new Set<string>();
    if (statuteIds.length && keys.length) {
      const rows = await this.db
        .selectDistinct({ statuteId: statuteSections.statuteId, key: statuteSections.normalizedSectionKey })
        .from(statuteSections)
        .where(and(inArray(statuteSections.statuteId, statuteIds), inArray(statuteSections.normalizedSectionKey, keys)));
      for (const r of rows) existing.add(`${r.statuteId}:${r.key}`);
    }
    return withStatute.map(({ ref, statuteId }) => ({ ...ref, statuteId: statuteId && existing.has(`${statuteId}:${ref.sectionKey}`) ? statuteId : null }));
  }
}

/** The `judgments.normalized_section_keys` copy: validated `statute_id:section_key` pairs, sorted. */
export const sectionKeysOf = (refs: ResolvedRef[]) => [...new Set(refs.filter((r) => r.statuteId).map((r) => `${r.statuteId}:${r.sectionKey}`))].sort();

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Replaces a judgment's links (call inside the judgment's write transaction). */
export async function replaceStatuteRefs(tx: Tx | Db, judgmentId: string, refs: ResolvedRef[]): Promise<void> {
  await tx.delete(judgmentStatuteRefs).where(eq(judgmentStatuteRefs.judgmentId, judgmentId));
  if (!refs.length) return;
  await tx.insert(judgmentStatuteRefs).values(
    refs.map((r) => ({
      referenceId: newId(),
      judgmentId,
      statuteId: r.statuteId,
      normalizedSectionKey: r.sectionKey,
      rawReferenceText: r.raw,
      paragraphNumbers: r.paragraphs,
      foundIn: r.foundIn,
    })),
  );
}

export interface RelinkSummary {
  judgments: number;
  /** Judgments whose validated `normalized_section_keys` changed (outbox event written). */
  changed: number;
  links: number;
}

const RELINK_PAGE = 50;

/**
 * Re-runs statute linking over stored judgments without downloading anything: after more Acts are
 * scraped, or after the detector or dictionary changes (`--scob-relink`). Judgments whose validated
 * keys changed get a `JUDGMENT_UPSERTED` event so the index (JUD-06) picks up the new filters.
 */
export async function relinkJudgments(db: Db, log: Log, opts: { judgmentIds?: string[] } = {}): Promise<RelinkSummary> {
  const linker = new StatuteLinker(db);
  const summary: RelinkSummary = { judgments: 0, changed: 0, links: 0 };
  let after: string | null = null;
  for (;;) {
    const conds: SQL[] = [...(after ? [gt(judgments.judgmentId, after)] : []), ...(opts.judgmentIds ? [inArray(judgments.judgmentId, opts.judgmentIds)] : [])];
    const page: { judgmentId: string; keyWords: string; fullText: string | null; keys: string[] }[] = await db
      .select({ judgmentId: judgments.judgmentId, keyWords: judgments.keyWords, fullText: judgments.fullText, keys: judgments.normalizedSectionKeys })
      .from(judgments)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(judgments.judgmentId))
      .limit(RELINK_PAGE);
    if (!page.length) break;
    for (const j of page) {
      const links = await linker.resolve(findStatuteRefs(j.keyWords, j.fullText));
      const keys = sectionKeysOf(links);
      const changed = JSON.stringify(keys) !== JSON.stringify([...j.keys].sort());
      await db.transaction(async (tx) => {
        await replaceStatuteRefs(tx, j.judgmentId, links);
        if (!changed) return;
        await tx.update(judgments).set({ normalizedSectionKeys: keys }).where(eq(judgments.judgmentId, j.judgmentId));
        await tx.insert(outboxEvents).values({ aggregate: 'judgment', aggregateId: j.judgmentId, eventType: 'JUDGMENT_UPSERTED', payload: { changed: false, statuteLinks: true } });
      });
      summary.judgments++;
      summary.links += keys.length;
      if (changed) summary.changed++;
    }
    after = page.at(-1)!.judgmentId;
    if (page.length < RELINK_PAGE) break;
  }
  log.info(summary, 'scob statute links rebuilt');
  return summary;
}
