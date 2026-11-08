import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { statutes, statuteSections, type Db } from '@lawassist/db';
import type { MergedSection } from '@lawassist/legal-text';

/**
 * Pinned sources for stage 6 (TRD §8.2, §7.4; BE-25): the text of each analysed section as in
 * force on the occurrence date, numbered [1], [2] … The model may cite only these numbers, and the
 * server keeps the mapping n → section_id to validate and to show the user the exact text.
 */
export interface PinnedSource {
  n: number;
  /** "PENAL_CODE:323": the same reference the role analysis uses for the section. */
  sectionRef: string;
  sectionId: string;
  actName: string;
  sectionNumber: string;
  marginalHeading: string | null;
  contentBody: string;
  versionNumber: number;
  validFrom: string;
  /** No version covers the occurrence date (e.g. text first scraped later): the current text is used. */
  currentTextUsed: boolean;
}

export const sectionRef = (s: Pick<MergedSection, 'act' | 'key'>) => `${s.act?.key ?? 'UNKNOWN_ACT'}:${s.key}`;

export async function loadPinnedSources(db: Db, sections: MergedSection[], onDate: string): Promise<PinnedSource[]> {
  const wanted = new Map<string, MergedSection>();
  for (const s of sections) if (s.act && !wanted.has(sectionRef(s))) wanted.set(sectionRef(s), s);
  if (!wanted.size) return [];

  const actIds = [...new Set([...wanted.values()].map((s) => s.act!.bdlawsActId))];
  const statuteRows = await db
    .select({ statuteId: statutes.statuteId, bdlawsActId: statutes.bdlawsActId, titleEn: statutes.titleEn, titleBn: statutes.titleBn })
    .from(statutes)
    .where(inArray(statutes.bdlawsActId, actIds));
  const statuteByAct = new Map(statuteRows.map((r) => [r.bdlawsActId, r]));

  const out: PinnedSource[] = [];
  for (const [ref, s] of wanted) {
    const statute = statuteByAct.get(s.act!.bdlawsActId);
    if (!statute) continue; // Act not in the corpus yet: no text to pin
    const base = and(eq(statuteSections.statuteId, statute.statuteId), eq(statuteSections.normalizedSectionKey, s.key));
    const [inForce] = await db
      .select()
      .from(statuteSections)
      .where(and(base, lte(statuteSections.validFrom, onDate), or(isNull(statuteSections.validTo), gt(statuteSections.validTo, onDate))))
      .orderBy(desc(statuteSections.validFrom))
      .limit(1);
    const row = inForce ?? (await db.select().from(statuteSections).where(and(base, eq(statuteSections.isCurrent, true))).limit(1))[0];
    if (!row) continue;
    out.push({
      n: out.length + 1,
      sectionRef: ref,
      sectionId: row.sectionId,
      actName: statute.titleEn ?? statute.titleBn ?? s.act!.name,
      sectionNumber: row.sectionNumber,
      marginalHeading: row.marginalHeading,
      contentBody: row.contentBody,
      versionNumber: row.versionNumber,
      validFrom: row.validFrom,
      currentTextUsed: !inForce,
    });
  }
  return out;
}

/** The numbered source blocks as the model sees them. */
export function renderSources(sources: PinnedSource[]): string {
  return sources
    .map(
      (s) =>
        `<source n="${s.n}" section_ref="${s.sectionRef}">\n${s.actName}, section ${s.sectionNumber}${s.marginalHeading ? ` (${s.marginalHeading})` : ''}\n${s.contentBody}\n</source>`,
    )
    .join('\n\n');
}
