import { asc, eq, inArray } from 'drizzle-orm';
import { statutes, statuteSections, type Db } from '@lawassist/db';
import { ACT_DICTIONARY } from '@lawassist/legal-text';
import type { Log } from '../scrape/run-scrape';
import type { SectionIndexer } from './indexer';
import type { JudgmentIndexer } from './judgment-indexer';

export interface PriorityBackfillSummary {
  judgments: number;
  acts: number;
  sections: number;
}

const JUDGMENT_PAGE = 10;
const SECTION_PAGE = 40;

/**
 * First indexing of a large corpus on slow (CPU-only) embeddings: the most used material first,
 * so search becomes useful hours before everything is embedded (`--index-priority`).
 *   1. every judgment (case law),
 *   2. the Acts of the citation dictionary (Penal Code, CrPC, Evidence Act, …), all versions.
 * The rest is left to the outbox. Both indexers skip chunks already embedded with the same model,
 * so the outbox later re-touches these items without embedding them again.
 */
export async function priorityBackfill(deps: { db: Db; sections: SectionIndexer; judgments: JudgmentIndexer; log: Log }): Promise<PriorityBackfillSummary> {
  const summary: PriorityBackfillSummary = { judgments: 0, acts: 0, sections: 0 };

  const ids: string[] = [];
  for await (const page of deps.judgments.allJudgmentIds(500)) ids.push(...page);
  for (let i = 0; i < ids.length; i += JUDGMENT_PAGE) {
    const r = await deps.judgments.indexJudgments(ids.slice(i, i + JUDGMENT_PAGE));
    summary.judgments += r.embedded + r.payloadOnly;
    deps.log.info({ step: 'judgments', done: Math.min(i + JUDGMENT_PAGE, ids.length), of: ids.length }, 'priority backfill progress');
  }

  const actIds = [...new Set(ACT_DICTIONARY.map((a) => a.bdlawsActId))];
  const acts = await deps.db.select({ statuteId: statutes.statuteId, bdlawsActId: statutes.bdlawsActId }).from(statutes).where(inArray(statutes.bdlawsActId, actIds));
  for (const act of acts) {
    const sectionIds = (await deps.db.select({ id: statuteSections.sectionId }).from(statuteSections).where(eq(statuteSections.statuteId, act.statuteId)).orderBy(asc(statuteSections.sectionId))).map((r) => r.id);
    for (let i = 0; i < sectionIds.length; i += SECTION_PAGE) {
      const r = await deps.sections.indexSections(sectionIds.slice(i, i + SECTION_PAGE));
      summary.sections += r.embedded + r.payloadOnly;
    }
    summary.acts++;
    deps.log.info({ step: 'acts', act: act.bdlawsActId, sections: sectionIds.length, actsDone: summary.acts, of: acts.length }, 'priority backfill progress');
  }
  deps.log.info(summary, 'priority backfill done');
  return summary;
}
