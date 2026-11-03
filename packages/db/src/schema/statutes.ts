import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { dt, timestamps, uuidBin } from './columns';
import { LANGUAGES, STATUTE_STATUSES, VALID_FROM_SOURCES } from './enums';

/** SRS 5.2 — master law index. FULLTEXT(title_en, title_bn) is added in a custom migration. */
export const statutes = mysqlTable(
  'statutes',
  {
    statuteId: uuidBin('statute_id').primaryKey(),
    bdlawsActId: int('bdlaws_act_id').notNull(),
    actNumber: varchar('act_number', { length: 120 }),
    titleEn: text('title_en'),
    titleBn: text('title_bn'),
    language: mysqlEnum('language', LANGUAGES).notNull(),
    enactedDate: date('enacted_date', { mode: 'string' }),
    status: mysqlEnum('status', STATUTE_STATUSES).notNull().default('ACTIVE'),
    sourceUrl: varchar('source_url', { length: 500 }).notNull(),
    rawHtmlS3Key: varchar('raw_html_s3_key', { length: 500 }),
    lastSyncedAt: dt('last_synced_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('uq_statutes_bdlaws_act').on(t.bdlawsActId)],
);

export interface AmendmentFootnote {
  action: 'SUBSTITUTED' | 'INSERTED' | 'OMITTED' | 'OTHER';
  byAct: string | null;
  date: string | null;
  text: string;
}

/**
 * SRS 5.3 — temporal versioned repository (TRD §4.2).
 * Embeddings live per chunk in Qdrant, not here. FULLTEXT(marginal_heading, content_body) is
 * added in a custom migration (drizzle-kit can't express ngram FULLTEXT indexes).
 */
export const statuteSections = mysqlTable(
  'statute_sections',
  {
    sectionId: uuidBin('section_id').primaryKey(),
    statuteId: uuidBin('statute_id')
      .notNull()
      .references(() => statutes.statuteId),
    chapterReference: varchar('chapter_reference', { length: 300 }),
    /** Section number as printed (e.g. "৫৬১ক"). */
    sectionNumber: varchar('section_number', { length: 32 }).notNull(),
    /** ASCII key for lookup (e.g. "561A"). */
    normalizedSectionKey: varchar('normalized_section_key', { length: 16 }).notNull(),
    marginalHeading: text('marginal_heading'),
    contentBody: mediumtext('content_body').notNull(),
    amendmentFootnotes: json('amendment_footnotes').$type<AmendmentFootnote[]>().notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    footnotesHash: varchar('footnotes_hash', { length: 64 }).notNull(),
    versionNumber: int('version_number').notNull(),
    isCurrent: boolean('is_current').notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    validFromSource: mysqlEnum('valid_from_source', VALID_FROM_SOURCES).notNull(),
    /**
     * MySQL has no partial unique index. This generated column is NULL for non-current rows
     * (UNIQUE allows many NULLs), so at most ONE current version per (statute, section) can exist.
     */
    currentKey: varchar('current_key', { length: 64 }).generatedAlwaysAs(
      sql`IF(is_current, CONCAT(HEX(statute_id), ':', normalized_section_key), NULL)`,
      { mode: 'stored' },
    ),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('uq_sections_current_key').on(t.currentKey),
    uniqueIndex('uq_sections_version').on(t.statuteId, t.normalizedSectionKey, t.versionNumber),
    index('ix_sections_point_in_time').on(t.statuteId, t.normalizedSectionKey, t.validFrom, t.validTo),
  ],
);

/** Retrieval chunks. Text here; vectors in Qdrant under the same chunk_id (TRD §4.4). */
export const sectionChunks = mysqlTable(
  'section_chunks',
  {
    chunkId: uuidBin('chunk_id').primaryKey(),
    sectionId: uuidBin('section_id')
      .notNull()
      .references(() => statuteSections.sectionId, { onDelete: 'cascade' }),
    chunkIndex: smallint('chunk_index').notNull(),
    chunkText: text('chunk_text').notNull(),
    embeddingModel: varchar('embedding_model', { length: 64 }),
    indexedAt: dt('indexed_at'),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [uniqueIndex('uq_chunks_section_idx').on(t.sectionId, t.chunkIndex)],
);

/** SRS 5.4 — deterministic CrPC Schedule II lookup. Only lawyer-verified rows go live (TRD §6.5). */
export const crpcScheduleMetadata = mysqlTable(
  'crpc_schedule_metadata',
  {
    scheduleId: uuidBin('schedule_id').primaryKey(),
    statuteId: uuidBin('statute_id')
      .notNull()
      .references(() => statutes.statuteId),
    sectionNumber: varchar('section_number', { length: 16 }).notNull(),
    offenseDescription: text('offense_description'),
    isCognizable: boolean('is_cognizable').notNull(),
    isBailable: boolean('is_bailable').notNull(),
    isCompoundable: boolean('is_compoundable').notNull(),
    maxPunishment: text('max_punishment').notNull(),
    triableByCourt: varchar('triable_by_court', { length: 200 }).notNull(),
    sourceReference: varchar('source_reference', { length: 300 }),
    verifiedBy: varchar('verified_by', { length: 200 }),
    verifiedAt: dt('verified_at'),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('uq_schedule_section_from').on(t.statuteId, t.sectionNumber, t.effectiveFrom)],
);
