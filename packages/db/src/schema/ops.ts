import { sql } from 'drizzle-orm';
import { bigint, index, int, json, mysqlEnum, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';
import { dt, uuidBin } from './columns';
import { SCRAPE_RUN_STATUSES } from './enums';

export const scrapeRuns = mysqlTable('scrape_runs', {
  runId: uuidBin('run_id').primaryKey(),
  /** bdlaws statutes (TRD §6.1) or SCOB judgments (TRD §6A). */
  source: mysqlEnum('source', ['BDLAWS', 'SCOB']).notNull().default('BDLAWS'),
  kind: mysqlEnum('kind', ['NIGHTLY', 'FULL', 'MANUAL', 'WEEKLY', 'BACKFILL']).notNull(),
  status: mysqlEnum('status', SCRAPE_RUN_STATUSES).notNull().default('RUNNING'),
  actsChecked: int('acts_checked').notNull().default(0),
  sectionsChanged: int('sections_changed').notNull().default(0),
  error: text('error'),
  /** Source-specific counts (SCOB: issues, lists, rows, queued). */
  details: json('details'),
  startedAt: dt('started_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  finishedAt: dt('finished_at'),
});

export const scrapeEvents = mysqlTable(
  'scrape_events',
  {
    eventId: uuidBin('event_id').primaryKey(),
    runId: uuidBin('run_id')
      .notNull()
      .references(() => scrapeRuns.runId, { onDelete: 'cascade' }),
    bdlawsActId: int('bdlaws_act_id'),
    level: mysqlEnum('level', ['INFO', 'WARN', 'ERROR']).notNull(),
    message: text('message').notNull(),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index('ix_scrape_events_run').on(t.runId)],
);

/** Transactional outbox: MySQL → Qdrant/embedding sync and case notifications (TRD §4.4). */
export const outboxEvents = mysqlTable(
  'outbox_events',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    aggregate: varchar('aggregate', { length: 64 }).notNull(),
    aggregateId: uuidBin('aggregate_id').notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    payload: json('payload').notNull(),
    attempts: int('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    processedAt: dt('processed_at'),
  },
  (t) => [index('ix_outbox_unprocessed').on(t.processedAt, t.id)],
);

/** Append-only. The app DB users get INSERT/SELECT only (see sql/grants.sql). */
export const auditLog = mysqlTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    actorUserId: uuidBin('actor_user_id'),
    action: varchar('action', { length: 100 }).notNull(),
    entity: varchar('entity', { length: 64 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }),
    details: json('details'),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index('ix_audit_entity').on(t.entity, t.entityId)],
);
