import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { outboxEvents, type Db } from '@lawassist/db';
import type { Log } from '../scrape/run-scrape';
import type { SectionIndexer } from './indexer';
import type { JudgmentIndexer } from './judgment-indexer';

/**
 * Outbox consumer for the vector index (TRD §4.4, §6.4).
 * - Reads unprocessed index events in id order and marks `processed_at` only after Qdrant confirmed.
 * - Handlers re-read MySQL, so replays and reordering are harmless (idempotent by construction).
 * - Failures increment `attempts` and store a short error (never document text); after
 *   MAX_ATTEMPTS an event is parked and needs an operator.
 * - NOTIFY_AFFECTED_CASES belongs to the notification consumer (App Flow §15.1) and is left alone.
 * Run with a single consumer (BullMQ concurrency 1). A second consumer would only duplicate work.
 */
export const INDEX_EVENT_TYPES = ['SECTION_VERSION_CREATED', 'SECTION_VERSION_CLOSED', 'STATUTE_STATUS_CHANGED'] as const;
/** Case law (JUD-06): handled when a judgment indexer is configured. */
export const JUDGMENT_EVENT_TYPES = ['JUDGMENT_UPSERTED', 'JUDGMENT_REMOVED'] as const;
export const MAX_ATTEMPTS = 10;

export interface OutboxDeps {
  db: Db;
  indexer: SectionIndexer;
  judgments?: JudgmentIndexer;
  log: Log;
  /**
   * Embedding server reachable? When it says no, the run is skipped without touching any event, so
   * an outage (TEI not started, models not downloaded) never uses up events' attempts.
   */
  ready?: () => Promise<boolean>;
}

export interface OutboxRunResult {
  processed: number;
  failed: number;
  /** True when the batch was full, so more events are probably waiting. */
  more: boolean;
}

type Event = { id: number; aggregateId: string; eventType: string; attempts: number };

export async function processOutboxBatch(
  deps: OutboxDeps,
  opts: { batchSize?: number } = {},
): Promise<OutboxRunResult> {
  const batchSize = opts.batchSize ?? 100;
  const events: Event[] = await deps.db
    .select({ id: outboxEvents.id, aggregateId: outboxEvents.aggregateId, eventType: outboxEvents.eventType, attempts: outboxEvents.attempts })
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.processedAt), inArray(outboxEvents.eventType, [...INDEX_EVENT_TYPES, ...(deps.judgments ? JUDGMENT_EVENT_TYPES : [])]), lt(outboxEvents.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(outboxEvents.id))
    .limit(batchSize);
  if (!events.length) return { processed: 0, failed: 0, more: false };

  const done: number[] = [];
  const failures: { id: number; error: string }[] = [];

  // 1. New versions: embed together for TEI batching. If the batch fails, retry one section at a
  //    time, so one bad section can't block the rest.
  const created = events.filter((e) => e.eventType === 'SECTION_VERSION_CREATED');
  if (created.length) {
    try {
      await deps.indexer.indexSections(created.map((e) => e.aggregateId));
      done.push(...created.map((e) => e.id));
    } catch {
      for (const e of created) {
        try {
          await deps.indexer.indexSections([e.aggregateId]);
          done.push(e.id);
        } catch (err) {
          failures.push({ id: e.id, error: describe(err) });
        }
      }
    }
  }

  // 1b. Judgments (re-read from MySQL; batch first, then one by one).
  const judgmentIndexer = deps.judgments;
  const upserted = events.filter((e) => e.eventType === 'JUDGMENT_UPSERTED');
  if (judgmentIndexer && upserted.length) {
    try {
      await judgmentIndexer.indexJudgments(upserted.map((e) => e.aggregateId));
      done.push(...upserted.map((e) => e.id));
    } catch {
      for (const e of upserted) {
        try {
          await judgmentIndexer.indexJudgments([e.aggregateId]);
          done.push(e.id);
        } catch (err) {
          failures.push({ id: e.id, error: describe(err) });
        }
      }
    }
  }

  // 2. Payload-only events. Order relative to step 1 doesn't matter: both write MySQL truth.
  for (const e of events.filter((ev) => ev.eventType !== 'SECTION_VERSION_CREATED' && ev.eventType !== 'JUDGMENT_UPSERTED')) {
    try {
      if (e.eventType === 'JUDGMENT_REMOVED') await judgmentIndexer!.remove(e.aggregateId);
      else if (e.eventType === 'SECTION_VERSION_CLOSED') await deps.indexer.refreshSectionPayload(e.aggregateId);
      else await deps.indexer.refreshStatutePayload(e.aggregateId);
      done.push(e.id);
    } catch (err) {
      failures.push({ id: e.id, error: describe(err) });
    }
  }

  if (done.length) {
    await deps.db.update(outboxEvents).set({ processedAt: new Date(), lastError: null }).where(inArray(outboxEvents.id, done));
  }
  for (const f of failures) {
    await deps.db
      .update(outboxEvents)
      .set({ attempts: sql`${outboxEvents.attempts} + 1`, lastError: f.error })
      .where(eq(outboxEvents.id, f.id));
    const ev = events.find((e) => e.id === f.id)!;
    const level = ev.attempts + 1 >= MAX_ATTEMPTS ? 'error' : 'warn';
    deps.log[level]({ outboxId: f.id, eventType: ev.eventType, attempts: ev.attempts + 1, err: f.error }, 'outbox event failed');
  }
  return { processed: done.length, failed: failures.length, more: events.length === batchSize };
}

/** Drains the outbox until empty or `maxBatches` is reached (one BullMQ job run). */
export async function drainOutbox(
  deps: OutboxDeps,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ processed: number; failed: number; skipped?: true }> {
  if (deps.ready && !(await deps.ready())) {
    return { processed: 0, failed: 0, skipped: true };
  }
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < (opts.maxBatches ?? 50); i++) {
    const r = await processOutboxBatch(deps, opts);
    processed += r.processed;
    failed += r.failed;
    // Stop when the queue is empty, or when a whole batch failed (TEI/Qdrant down: retry next tick).
    if (!r.more || r.processed === 0) break;
  }
  return { processed, failed };
}

/** Error text for logs and `outbox_events.last_error`: name + message, capped, no payloads. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  return `${err.name}: ${err.message}`.slice(0, 500);
}
