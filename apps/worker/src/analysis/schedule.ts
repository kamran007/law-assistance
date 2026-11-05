import { and, desc, gt, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { crpcScheduleMetadata, statutes, type Db } from '@lawassist/db';
import type { MergedSection } from '@lawassist/legal-text';

/**
 * Stage 5 (TRD §8.2, BE-24): Schedule II join. Bail / cognizable / compoundable status comes ONLY
 * from lawyer-verified `crpc_schedule_metadata` rows in force on the occurrence date, never from
 * the LLM (CLAUDE.md). Anything without such a row is tagged `NOT_IN_VERIFIED_SCHEDULE`; the UI
 * shows "not in the verified schedule", not a guess.
 */
export interface ScheduleTags {
  isCognizable: boolean;
  isBailable: boolean;
  isCompoundable: boolean;
  maxPunishment: string;
  triableByCourt: string;
  offenseDescription: string | null;
  sourceReference: string | null;
  /** Which row matched: "11(গ)" for a clause-specific row, else the section key. */
  matchedSection: string;
  effectiveFrom: string;
}

export type ScheduleStatus = 'VERIFIED' | 'NOT_IN_VERIFIED_SCHEDULE';

export interface TaggedSection extends MergedSection {
  scheduleStatus: ScheduleStatus;
  schedule: ScheduleTags | null;
}

type Row = typeof crpcScheduleMetadata.$inferSelect;

/** Candidate `section_number` values, most specific first: "11(গ)" before "11". */
function candidates(s: MergedSection): string[] {
  const sub = s.subsection?.replace(/\s*table\s.*$/, '').trim();
  return sub ? [`${s.key}${sub}`, s.key] : [s.key];
}

export async function joinScheduleII(db: Db, sections: MergedSection[], onDate: string): Promise<TaggedSection[]> {
  const actIds = [...new Set(sections.map((s) => s.act?.bdlawsActId).filter((id): id is number => id !== undefined))];
  const statuteRows = actIds.length
    ? await db.select({ statuteId: statutes.statuteId, bdlawsActId: statutes.bdlawsActId }).from(statutes).where(inArray(statutes.bdlawsActId, actIds))
    : [];
  const statuteByAct = new Map(statuteRows.map((r) => [r.bdlawsActId, r.statuteId]));

  const wanted = sections.flatMap((s) => (s.act && statuteByAct.has(s.act.bdlawsActId) ? candidates(s) : []));
  const rows: Row[] =
    wanted.length && statuteByAct.size
      ? await db
          .select()
          .from(crpcScheduleMetadata)
          .where(
            and(
              inArray(crpcScheduleMetadata.statuteId, [...statuteByAct.values()]),
              inArray(crpcScheduleMetadata.sectionNumber, [...new Set(wanted)]),
              isNotNull(crpcScheduleMetadata.verifiedAt), // TRD §6.5: no row goes live unverified
              lte(crpcScheduleMetadata.effectiveFrom, onDate),
              or(isNull(crpcScheduleMetadata.effectiveTo), gt(crpcScheduleMetadata.effectiveTo, onDate)),
            ),
          )
          .orderBy(desc(crpcScheduleMetadata.effectiveFrom))
      : [];

  // Newest effective row first (ordered above), so the first hit per (statute, section) wins.
  const find = (statuteId: string, section: string) => rows.find((r) => r.statuteId === statuteId && r.sectionNumber === section);

  return sections.map((s) => {
    const statuteId = s.act ? statuteByAct.get(s.act.bdlawsActId) : undefined;
    for (const c of statuteId ? candidates(s) : []) {
      const r = find(statuteId!, c);
      if (r) {
        return {
          ...s,
          scheduleStatus: 'VERIFIED' as const,
          schedule: {
            isCognizable: r.isCognizable,
            isBailable: r.isBailable,
            isCompoundable: r.isCompoundable,
            maxPunishment: r.maxPunishment,
            triableByCourt: r.triableByCourt,
            offenseDescription: r.offenseDescription,
            sourceReference: r.sourceReference,
            matchedSection: c,
            effectiveFrom: r.effectiveFrom,
          },
        };
      }
    }
    return { ...s, scheduleStatus: 'NOT_IN_VERIFIED_SCHEDULE' as const, schedule: null };
  });
}
