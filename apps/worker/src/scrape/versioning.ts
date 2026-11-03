import { and, eq } from 'drizzle-orm';
import { newId, outboxEvents, statutes, statuteSections, type Db } from '@lawassist/db';
import type { ParsedFootnote } from '@lawassist/legal-text';
import type { ParsedAct, ParsedSection } from './parser';

/**
 * Temporal versioning (TRD §6.3). Flow per Act:
 *   1. plan (read-only): compare parsed sections with the current versions;
 *   2. safety valve: > 20% of an existing Act changed → quarantine, write nothing;
 *   3. apply: one REPEATABLE READ transaction per section, current row locked FOR UPDATE,
 *      version rows + outbox events written atomically.
 * The `uq_sections_current_key` UNIQUE index guarantees one current row even under concurrent
 * workers; a losing worker gets a duplicate-key error and simply re-runs the section, which then
 * sees the winner's row and becomes a no-op.
 */
export const MAX_CHANGE_RATIO = 0.2;

export interface CurrentSectionRow {
  sectionId: string;
  normalizedSectionKey: string;
  contentHash: string;
  footnotesHash: string;
}

export interface SyncPlan {
  create: ParsedSection[];
  change: ParsedSection[];
  remove: CurrentSectionRow[];
  unchanged: number;
  /** (create + change + remove) / existing current sections; 0 for a first ingest. */
  changeRatio: number;
}

export function planActSync(current: readonly CurrentSectionRow[], parsed: readonly ParsedSection[]): SyncPlan {
  const byKey = new Map(current.map((r) => [r.normalizedSectionKey, r]));
  const parsedKeys = new Set(parsed.map((s) => s.normalizedSectionKey));
  const plan: SyncPlan = { create: [], change: [], remove: [], unchanged: 0, changeRatio: 0 };
  for (const s of parsed) {
    const cur = byKey.get(s.normalizedSectionKey);
    if (!cur) plan.create.push(s);
    else if (cur.contentHash !== s.contentHash || cur.footnotesHash !== s.footnotesHash) plan.change.push(s);
    else plan.unchanged++;
  }
  plan.remove = current.filter((r) => !parsedKeys.has(r.normalizedSectionKey));
  if (current.length) plan.changeRatio = (plan.create.length + plan.change.length + plan.remove.length) / current.length;
  return plan;
}

type ValidFromSource = 'AMENDMENT_FOOTNOTE' | 'ENACTMENT_DATE' | 'DETECTED_ON_SYNC';

/**
 * Effective date of a new version: the latest dated footnote that is new in this version
 * (TRD §6.3 "amendment date parsed from the new footnote"), else `today`.
 */
export function effectiveDate(
  newFootnotes: readonly ParsedFootnote[],
  oldFootnotes: readonly { text: string }[],
  today: string,
): { date: string; source: ValidFromSource } {
  const old = new Set(oldFootnotes.map((f) => f.text));
  const dates = newFootnotes.filter((f) => !old.has(f.text) && f.date).map((f) => f.date!);
  if (!dates.length) return { date: today, source: 'DETECTED_ON_SYNC' };
  return { date: dates.sort().at(-1)!, source: 'AMENDMENT_FOOTNOTE' };
}

/** valid_from for a section seen for the first time. */
export function firstVersionValidFrom(
  s: ParsedSection,
  ctx: { enactedDate: string | null; firstIngest: boolean; today: string },
): { date: string; source: ValidFromSource } {
  const inserted = s.footnotes.filter((f) => f.action === 'INSERTED' && f.date).map((f) => f.date!);
  if (inserted.length) return { date: inserted.sort().at(-1)!, source: 'AMENDMENT_FOOTNOTE' };
  if (ctx.firstIngest && ctx.enactedDate) return { date: ctx.enactedDate, source: 'ENACTMENT_DATE' };
  if (!ctx.firstIngest) return effectiveDate(s.footnotes, [], ctx.today);
  return { date: ctx.today, source: 'DETECTED_ON_SYNC' };
}

export type SyncResult =
  | { status: 'QUARANTINED'; statuteId: string | null; plan: PlanCounts }
  | { status: 'SYNCED'; statuteId: string; plan: PlanCounts; created: number; versioned: number; closed: number };

export interface PlanCounts {
  create: number;
  change: number;
  remove: number;
  unchanged: number;
  changeRatio: number;
}

export interface SyncOptions {
  /** ISO date (Asia/Dhaka) used when no amendment date is known. */
  today: string;
  snapshotKey: string | null;
  maxChangeRatio?: number;
  /** Admin override after reviewing a quarantined run. */
  force?: boolean;
}

export async function syncAct(db: Db, act: ParsedAct, opts: SyncOptions): Promise<SyncResult> {
  const [existing] = await db
    .select({ statuteId: statutes.statuteId, status: statutes.status })
    .from(statutes)
    .where(eq(statutes.bdlawsActId, act.bdlawsActId));

  const current: CurrentSectionRow[] = existing
    ? await db
        .select({
          sectionId: statuteSections.sectionId,
          normalizedSectionKey: statuteSections.normalizedSectionKey,
          contentHash: statuteSections.contentHash,
          footnotesHash: statuteSections.footnotesHash,
        })
        .from(statuteSections)
        .where(and(eq(statuteSections.statuteId, existing.statuteId), eq(statuteSections.isCurrent, true)))
    : [];

  // A repealed Act often shows only a "[Repealed]" note. Its sections stay in place for historical
  // queries (TRD §6.3), so an empty repealed page changes the status only.
  const plan =
    act.isRepealed && act.sections.length === 0
      ? { create: [], change: [], remove: [], unchanged: current.length, changeRatio: 0 }
      : planActSync(current, act.sections);
  const counts: PlanCounts = {
    create: plan.create.length,
    change: plan.change.length,
    remove: plan.remove.length,
    unchanged: plan.unchanged,
    changeRatio: plan.changeRatio,
  };
  if (!opts.force && plan.changeRatio > (opts.maxChangeRatio ?? MAX_CHANGE_RATIO)) {
    return { status: 'QUARANTINED', statuteId: existing?.statuteId ?? null, plan: counts };
  }

  const statuteId = await withRetry(() => upsertStatute(db, act, opts.snapshotKey));
  const firstIngest = current.length === 0;
  let created = 0;
  let versioned = 0;
  for (const s of [...plan.create, ...plan.change]) {
    const r = await withRetry(() => applySection(db, statuteId, act, s, { today: opts.today, firstIngest }));
    if (r === 'created') created++;
    else if (r === 'versioned') versioned++;
  }
  let closed = 0;
  for (const r of plan.remove) {
    if (await withRetry(() => closeRemovedSection(db, statuteId, r.sectionId, opts.today))) closed++;
  }

  await db
    .update(statutes)
    .set({ lastSyncedAt: new Date(), ...(opts.snapshotKey ? { rawHtmlS3Key: opts.snapshotKey } : {}) })
    .where(eq(statutes.statuteId, statuteId));

  return { status: 'SYNCED', statuteId, plan: counts, created, versioned, closed };
}

async function upsertStatute(db: Db, act: ParsedAct, snapshotKey: string | null): Promise<string> {
  const status = act.isRepealed ? 'REPEALED' : 'ACTIVE';
  return db.transaction(
    async (tx) => {
      const [row] = await tx
        .select({ statuteId: statutes.statuteId, status: statutes.status })
        .from(statutes)
        .where(eq(statutes.bdlawsActId, act.bdlawsActId))
        .for('update');
      const fields = {
        actNumber: act.actNumber,
        ...(act.language === 'BN' ? { titleBn: act.title } : { titleEn: act.title }),
        language: act.language,
        enactedDate: act.enactedDate,
        status,
        sourceUrl: act.sourceUrl,
        ...(snapshotKey ? { rawHtmlS3Key: snapshotKey } : {}),
      } as const;
      if (!row) {
        const statuteId = newId();
        await tx.insert(statutes).values({ statuteId, bdlawsActId: act.bdlawsActId, ...fields });
        return statuteId;
      }
      await tx.update(statutes).set(fields).where(eq(statutes.statuteId, row.statuteId));
      if (row.status !== status) {
        // Propagates to Qdrant act_status via the outbox worker (TRD §6.3 "Repealed Acts").
        await tx.insert(outboxEvents).values({
          aggregate: 'statute',
          aggregateId: row.statuteId,
          eventType: 'STATUTE_STATUS_CHANGED',
          payload: { statuteId: row.statuteId, from: row.status, to: status },
        });
      }
      return row.statuteId;
    },
    { isolationLevel: 'repeatable read' },
  );
}

type ApplyOutcome = 'created' | 'versioned' | 'unchanged';

async function applySection(
  db: Db,
  statuteId: string,
  act: ParsedAct,
  s: ParsedSection,
  ctx: { today: string; firstIngest: boolean },
): Promise<ApplyOutcome> {
  return db.transaction(
    async (tx) => {
      const [cur] = await tx
        .select({
          sectionId: statuteSections.sectionId,
          versionNumber: statuteSections.versionNumber,
          validFrom: statuteSections.validFrom,
          contentHash: statuteSections.contentHash,
          footnotesHash: statuteSections.footnotesHash,
          amendmentFootnotes: statuteSections.amendmentFootnotes,
        })
        .from(statuteSections)
        .where(
          and(
            eq(statuteSections.statuteId, statuteId),
            eq(statuteSections.normalizedSectionKey, s.normalizedSectionKey),
            eq(statuteSections.isCurrent, true),
          ),
        )
        .for('update');

      const row = {
        statuteId,
        chapterReference: s.chapterReference,
        sectionNumber: s.sectionNumber,
        normalizedSectionKey: s.normalizedSectionKey,
        marginalHeading: s.marginalHeading,
        contentBody: s.contentBody,
        amendmentFootnotes: s.footnotes,
        contentHash: s.contentHash,
        footnotesHash: s.footnotesHash,
        isCurrent: true,
      };

      if (!cur) {
        const vf = firstVersionValidFrom(s, { enactedDate: act.enactedDate, firstIngest: ctx.firstIngest, today: ctx.today });
        const sectionId = newId();
        await tx.insert(statuteSections).values({ ...row, sectionId, versionNumber: 1, validFrom: vf.date, validFromSource: vf.source });
        await tx.insert(outboxEvents).values(sectionEvent('SECTION_VERSION_CREATED', sectionId, statuteId, s.normalizedSectionKey, 1));
        return 'created';
      }
      if (cur.contentHash === s.contentHash && cur.footnotesHash === s.footnotesHash) return 'unchanged';

      const eff = effectiveDate(s.footnotes, cur.amendmentFootnotes, ctx.today);
      // A version can't end before it started (e.g. a footnote dated earlier than a back-filled v1).
      const validFrom = eff.date < cur.validFrom ? cur.validFrom : eff.date;
      const footnoteOnly = cur.contentHash === s.contentHash;

      await tx
        .update(statuteSections)
        .set({ isCurrent: false, validTo: validFrom })
        .where(eq(statuteSections.sectionId, cur.sectionId));
      const sectionId = newId();
      const version = cur.versionNumber + 1;
      await tx.insert(statuteSections).values({ ...row, sectionId, versionNumber: version, validFrom, validFromSource: eff.source });
      await tx.insert(outboxEvents).values([
        sectionEvent('SECTION_VERSION_CLOSED', cur.sectionId, statuteId, s.normalizedSectionKey, cur.versionNumber, { validTo: validFrom }),
        sectionEvent('SECTION_VERSION_CREATED', sectionId, statuteId, s.normalizedSectionKey, version, { footnoteOnly }),
        // App Flow §15.1: cases citing this section get an "amended" notice. Footnote-only changes too:
        // the worker decides whether to notify.
        sectionEvent('NOTIFY_AFFECTED_CASES', sectionId, statuteId, s.normalizedSectionKey, version, { footnoteOnly }),
      ]);
      return 'versioned';
    },
    { isolationLevel: 'repeatable read' },
  );
}

/** Sections that disappeared from the portal are superseded, never deleted (TRD §6.3). */
async function closeRemovedSection(db: Db, statuteId: string, sectionId: string, today: string): Promise<boolean> {
  return db.transaction(
    async (tx) => {
      const [cur] = await tx
        .select({
          normalizedSectionKey: statuteSections.normalizedSectionKey,
          versionNumber: statuteSections.versionNumber,
          validFrom: statuteSections.validFrom,
          isCurrent: statuteSections.isCurrent,
        })
        .from(statuteSections)
        .where(eq(statuteSections.sectionId, sectionId))
        .for('update');
      if (!cur?.isCurrent) return false;
      const validTo = today < cur.validFrom ? cur.validFrom : today;
      await tx.update(statuteSections).set({ isCurrent: false, validTo }).where(eq(statuteSections.sectionId, sectionId));
      await tx
        .insert(outboxEvents)
        .values(sectionEvent('SECTION_VERSION_CLOSED', sectionId, statuteId, cur.normalizedSectionKey, cur.versionNumber, { validTo, reason: 'REMOVED_FROM_SOURCE' }));
      return true;
    },
    { isolationLevel: 'repeatable read' },
  );
}

function sectionEvent(
  eventType: 'SECTION_VERSION_CREATED' | 'SECTION_VERSION_CLOSED' | 'NOTIFY_AFFECTED_CASES',
  sectionId: string,
  statuteId: string,
  normalizedSectionKey: string,
  versionNumber: number,
  extra: Record<string, unknown> = {},
) {
  return {
    aggregate: 'statute_section',
    aggregateId: sectionId,
    eventType,
    payload: { sectionId, statuteId, normalizedSectionKey, versionNumber, ...extra },
  };
}

const ER_DUP_ENTRY = 1062;
const ER_LOCK_DEADLOCK = 1213;
const ER_LOCK_WAIT_TIMEOUT = 1205;

/** Retries a section transaction that lost a race to a concurrent worker (TRD §6.3). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const errno = mysqlErrno(err);
      const retryable = errno === ER_DUP_ENTRY || errno === ER_LOCK_DEADLOCK || errno === ER_LOCK_WAIT_TIMEOUT;
      if (!retryable || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 25 * i + Math.random() * 50));
    }
  }
}

/** Drizzle wraps driver errors (`DrizzleQueryError.cause`); look through the chain. */
export function mysqlErrno(err: unknown): number | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const errno = (e as { errno?: unknown }).errno;
    if (typeof errno === 'number') return errno;
  }
  return undefined;
}
