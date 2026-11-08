import { and, asc, count, desc, eq, isNotNull, isNull, lte, gt, or, sql, type SQL } from 'drizzle-orm';
import { crpcScheduleMetadata, statutes, statuteSections, type Db } from '@lawassist/db';
import { compareSectionKeys } from './section-order';

/**
 * Read-only queries for the public statute API (TRD §5.1, BE-06). Statutes are not tenant data,
 * so these use the plain tables, not `scoped()`.
 */
export type StatuteRow = typeof statutes.$inferSelect;
export type SectionRow = typeof statuteSections.$inferSelect;
export type ScheduleRow = typeof crpcScheduleMetadata.$inferSelect;

export interface StatuteSearch {
  q?: string | undefined;
  status?: 'ACTIVE' | 'REPEALED' | undefined;
  year?: number | undefined;
  limit: number;
  offset: number;
}

/** `valid_from ≤ d < valid_to` (open-ended when valid_to is NULL): the version in force on d. */
const inForceOn = (d: string): SQL =>
  and(lte(statuteSections.validFrom, d), or(isNull(statuteSections.validTo), gt(statuteSections.validTo, d)))!;

export class StatutesRepository {
  constructor(private readonly db: Db) {}

  async search(p: StatuteSearch): Promise<{ total: number; items: StatuteRow[] }> {
    const where: SQL[] = [];
    if (p.status) where.push(eq(statutes.status, p.status));
    if (p.year) where.push(sql`YEAR(${statutes.enactedDate}) = ${p.year}`);
    // ngram FULLTEXT on both titles (migration 0001), so Bangla and English queries both work.
    const match = p.q ? sql`MATCH(${statutes.titleEn}, ${statutes.titleBn}) AGAINST (${p.q} IN NATURAL LANGUAGE MODE)` : null;
    if (match) where.push(sql`${match} > 0`);
    const cond = where.length ? and(...where) : undefined;

    const [totalRow] = await this.db.select({ n: count() }).from(statutes).where(cond);
    const items = await this.db
      .select()
      .from(statutes)
      .where(cond)
      // Newest first (unknown dates last); a title search keeps the best match on top.
      .orderBy(...(match ? [desc(match)] : []), sql`${statutes.enactedDate} IS NULL`, desc(statutes.enactedDate), desc(statutes.bdlawsActId))
      .limit(p.limit)
      .offset(p.offset);
    return { total: Number(totalRow?.n ?? 0), items };
  }

  async byActId(bdlawsActId: number): Promise<StatuteRow | undefined> {
    const [row] = await this.db.select().from(statutes).where(eq(statutes.bdlawsActId, bdlawsActId));
    return row;
  }

  /** Current sections of an Act in natural section order (for the chapter tree). */
  async currentSectionOutline(statuteId: string) {
    const rows = await this.db
      .select({
        sectionNumber: statuteSections.sectionNumber,
        normalizedSectionKey: statuteSections.normalizedSectionKey,
        marginalHeading: statuteSections.marginalHeading,
        chapterReference: statuteSections.chapterReference,
      })
      .from(statuteSections)
      .where(and(eq(statuteSections.statuteId, statuteId), eq(statuteSections.isCurrent, true)));
    return rows.sort((a, b) => compareSectionKeys(a.normalizedSectionKey, b.normalizedSectionKey));
  }

  /** The current version, or the version in force on `asOf`. */
  async section(statuteId: string, key: string, asOf: string | null): Promise<SectionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(statuteSections)
      .where(
        and(
          eq(statuteSections.statuteId, statuteId),
          eq(statuteSections.normalizedSectionKey, key),
          asOf ? inForceOn(asOf) : eq(statuteSections.isCurrent, true),
        ),
      )
      .orderBy(desc(statuteSections.versionNumber))
      .limit(1);
    return row;
  }

  async versions(statuteId: string, key: string): Promise<SectionRow[]> {
    return this.db
      .select()
      .from(statuteSections)
      .where(and(eq(statuteSections.statuteId, statuteId), eq(statuteSections.normalizedSectionKey, key)))
      .orderBy(asc(statuteSections.versionNumber));
  }

  /**
   * The Schedule II row for a section on a date. Only lawyer-verified rows are ever returned
   * (TRD §6.5: no row goes live unverified).
   */
  async scheduleRow(statuteId: string, key: string, on: string): Promise<ScheduleRow | undefined> {
    const [row] = await this.db
      .select()
      .from(crpcScheduleMetadata)
      .where(
        and(
          eq(crpcScheduleMetadata.statuteId, statuteId),
          eq(crpcScheduleMetadata.sectionNumber, key),
          isNotNull(crpcScheduleMetadata.verifiedAt),
          lte(crpcScheduleMetadata.effectiveFrom, on),
          or(isNull(crpcScheduleMetadata.effectiveTo), gt(crpcScheduleMetadata.effectiveTo, on)),
        ),
      )
      .orderBy(desc(crpcScheduleMetadata.effectiveFrom))
      .limit(1);
    return row;
  }
}
