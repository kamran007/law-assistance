import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { judgments, judgmentStatuteRefs, statutes, statuteSections, type Db } from '@lawassist/db';
import { requiredWords, type Sort } from '../../fulltext';

/**
 * Read-only queries for the public case-law API (TRD §5.1; JUD-07). Judgments are public reference
 * data, not tenant tables. Search is MySQL FULLTEXT (ngram) over parties, key words and summary for
 * now; the hybrid case-law arm (TRD §7.1) replaces it once retrieval (BE-07) exists.
 */
export type JudgmentRow = typeof judgments.$inferSelect;

export interface JudgmentSearch {
  q?: string | undefined;
  division?: 'AD' | 'HCD' | undefined;
  year?: number | undefined;
  /** Resolved `statutes.statute_id` (from act_id). */
  statuteId?: string | undefined;
  sectionKey?: string | undefined;
  judge?: string | undefined;
  sort?: Sort | undefined;
  limit: number;
  offset: number;
}

export interface RefRow {
  bdlawsActId: number | null;
  titleEn: string | null;
  titleBn: string | null;
  sectionKey: string | null;
  raw: string;
  paragraphs: string[];
  foundIn: 'KEY_WORDS' | 'BODY';
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/**
 * Newest first. A judgment without a decision date is placed by its bulletin year (start of the
 * year), so it doesn't sink below decades of older cases. Ties: later issue, AD before HCD, serial.
 */
const newestFirst = [
  desc(sql`COALESCE(${judgments.decisionDate}, MAKEDATE(${judgments.issueYear}, 1))`),
  desc(judgments.issueNumber),
  asc(judgments.division),
  asc(judgments.serialNumber),
];

export class JudgmentsRepository {
  constructor(private readonly db: Db) {}

  async statuteIdByActId(bdlawsActId: number): Promise<string | undefined> {
    const [row] = await this.db.select({ id: statutes.statuteId }).from(statutes).where(eq(statutes.bdlawsActId, bdlawsActId));
    return row?.id;
  }

  async search(p: JudgmentSearch): Promise<{ total: number; items: JudgmentRow[] }> {
    const where: SQL[] = [];
    if (p.division) where.push(eq(judgments.division, p.division));
    if (p.year) where.push(sql`COALESCE(YEAR(${judgments.decisionDate}), ${judgments.issueYear}) = ${p.year}`);
    if (p.judge) {
      const like = `%${likeEscape(p.judge)}%`;
      where.push(sql`(${judgments.authoringJudge} LIKE ${like} OR JSON_SEARCH(${judgments.bench}, 'one', ${like}) IS NOT NULL)`);
    }
    if (p.statuteId) {
      where.push(
        sql`EXISTS (SELECT 1 FROM ${judgmentStatuteRefs} r WHERE r.judgment_id = ${judgments.judgmentId} AND r.statute_id = ${uuidParam(p.statuteId)}${
          p.sectionKey ? sql` AND r.normalized_section_key = ${p.sectionKey}` : sql``
        })`,
      );
    }
    // ngram FULLTEXT (migration 0003), Bangla and English. BOOLEAN mode: each word is a phrase of
    // its ngrams, so a name matches wherever it occurs (natural-language mode drops ngrams that
    // occur in half the rows). The user's text is reduced to plain words first.
    const words = p.q ? requiredWords(p.q) : '';
    const match = words ? sql`MATCH(${judgments.parties}, ${judgments.keyWords}, ${judgments.summary}) AGAINST (${words} IN BOOLEAN MODE)` : null;
    if (match) where.push(sql`${match} > 0`);
    const cond = where.length ? and(...where) : undefined;

    const [totalRow] = await this.db.select({ n: count() }).from(judgments).where(cond);
    const items = await this.db
      .select()
      .from(judgments)
      .where(cond)
      // Newest first, or best match first when asked.
      .orderBy(...(match && p.sort === 'relevance' ? [desc(match)] : []), ...newestFirst)
      .limit(p.limit)
      .offset(p.offset);
    return { total: Number(totalRow?.n ?? 0), items };
  }

  async byId(judgmentId: string): Promise<JudgmentRow | undefined> {
    const [row] = await this.db.select().from(judgments).where(eq(judgments.judgmentId, judgmentId));
    return row;
  }

  /** Linked sections in a stable order: key words first, then body by first paragraph. */
  async refs(judgmentId: string): Promise<RefRow[]> {
    const rows = await this.db
      .select({
        bdlawsActId: statutes.bdlawsActId,
        titleEn: statutes.titleEn,
        titleBn: statutes.titleBn,
        sectionKey: judgmentStatuteRefs.normalizedSectionKey,
        raw: judgmentStatuteRefs.rawReferenceText,
        paragraphs: judgmentStatuteRefs.paragraphNumbers,
        foundIn: judgmentStatuteRefs.foundIn,
      })
      .from(judgmentStatuteRefs)
      .leftJoin(statutes, eq(statutes.statuteId, judgmentStatuteRefs.statuteId))
      .where(eq(judgmentStatuteRefs.judgmentId, judgmentId));
    const first = (r: RefRow) => Number(r.paragraphs[0] ?? 0);
    return rows.sort((a, b) => (a.foundIn === b.foundIn ? first(a) - first(b) : a.foundIn === 'KEY_WORDS' ? -1 : 1));
  }

  /** The current version of a section (for the "older than current version" flag), if any. */
  async currentSection(statuteId: string, key: string): Promise<{ versionNumber: number; validFrom: string } | undefined> {
    const [row] = await this.db
      .select({ versionNumber: statuteSections.versionNumber, validFrom: statuteSections.validFrom })
      .from(statuteSections)
      .where(and(eq(statuteSections.statuteId, statuteId), eq(statuteSections.normalizedSectionKey, key), eq(statuteSections.isCurrent, true)))
      .limit(1);
    return row;
  }

  /** Judgments linked to one section, newest first, with the citing paragraphs merged. */
  async bySection(statuteId: string, key: string, page: { limit: number; offset: number }): Promise<{ total: number; items: { row: JudgmentRow; paragraphs: string[] }[] }> {
    const linked = and(eq(judgmentStatuteRefs.statuteId, statuteId), eq(judgmentStatuteRefs.normalizedSectionKey, key));
    const [totalRow] = await this.db.select({ n: sql<number>`COUNT(DISTINCT ${judgmentStatuteRefs.judgmentId})` }).from(judgmentStatuteRefs).where(linked);
    const rows = await this.db
      .select()
      .from(judgments)
      .where(sql`EXISTS (SELECT 1 FROM ${judgmentStatuteRefs} r WHERE r.judgment_id = ${judgments.judgmentId} AND r.statute_id = ${uuidParam(statuteId)} AND r.normalized_section_key = ${key})`)
      .orderBy(...newestFirst)
      .limit(page.limit)
      .offset(page.offset);
    if (!rows.length) return { total: Number(totalRow?.n ?? 0), items: [] };
    const refs = await this.db
      .select({ judgmentId: judgmentStatuteRefs.judgmentId, paragraphs: judgmentStatuteRefs.paragraphNumbers })
      .from(judgmentStatuteRefs)
      .where(and(linked, inArray(judgmentStatuteRefs.judgmentId, rows.map((r) => r.judgmentId))));
    return {
      total: Number(totalRow?.n ?? 0),
      items: rows.map((row) => {
        const paragraphs = [...new Set(refs.filter((r) => r.judgmentId === row.judgmentId).flatMap((r) => r.paragraphs))].sort((a, b) => Number(a) - Number(b));
        return { row, paragraphs };
      }),
    };
  }
}

/** A UUID as the BINARY(16) the columns store, for raw SQL fragments. */
function uuidParam(id: string): SQL {
  return sql`UNHEX(${id.replace(/-/g, '')})`;
}
