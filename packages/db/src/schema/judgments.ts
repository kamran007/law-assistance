import { sql } from 'drizzle-orm';
import { date, index, json, mediumtext, mysqlEnum, mysqlTable, smallint, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { dt, timestamps, uuidBin } from './columns';
import { statutes } from './statutes';

/**
 * Case law (Module D; SRS 5.7–5.8, TRD §4.2). Public reference data from the Supreme Court Online
 * Bulletin: NOT tenant tables, no owner. Written only by the scraper DB user (grants.sql).
 */
export const JUDGMENT_DIVISIONS = ['AD', 'HCD'] as const;
export const JUDGMENT_LANGUAGES = ['EN', 'BN', 'MIXED'] as const;
export const EXTRACTION_STATUSES = ['OK', 'OCR_USED', 'NEEDS_REVIEW'] as const;
export const DECISION_DATE_SOURCES = ['PDF_RULE', 'PDF_LLM', 'MANUAL'] as const;
export const JUDGMENT_REF_SOURCES = ['KEY_WORDS', 'BODY'] as const;

export const judgments = mysqlTable(
  'judgments',
  {
    judgmentId: uuidBin('judgment_id').primaryKey(),
    source: mysqlEnum('source', ['SCOB']).notNull().default('SCOB'),
    issueNumber: smallint('issue_number').notNull(),
    issueYear: smallint('issue_year').notNull(),
    division: mysqlEnum('division', JUDGMENT_DIVISIONS).notNull(),
    serialNumber: smallint('serial_number').notNull(),
    /** As published ("20 SCOB [2025] AD", "5 SCOB[2015]AD 1"); from the PDF when the list has none. */
    citation: varchar('citation', { length: 100 }).notNull(),
    caseNumber: varchar('case_number', { length: 500 }),
    parties: text('parties').notNull(),
    authoringJudge: varchar('authoring_judge', { length: 200 }),
    bench: json('bench').$type<string[]>(),
    decisionDate: date('decision_date', { mode: 'string' }),
    decisionDateSource: mysqlEnum('decision_date_source', DECISION_DATE_SOURCES),
    keyWords: text('key_words').notNull(),
    summary: mediumtext('summary'),
    keyRatioParagraphs: json('key_ratio_paragraphs').$type<string[]>().notNull(),
    language: mysqlEnum('language', JUDGMENT_LANGUAGES).notNull().default('EN'),
    /** Paragraph numbers kept as `[para n]` markers (TRD §6A.3 step 4). */
    fullText: mediumtext('full_text'),
    sourcePdfUrl: varchar('source_pdf_url', { length: 500 }).notNull(),
    /** `raw/scob/{issue}/{division}/{serial}/{pdf_sha256}.pdf`; presigned GET on demand. */
    storedPdfKey: varchar('stored_pdf_key', { length: 500 }),
    pdfSha256: varchar('pdf_sha256', { length: 64 }),
    listingHtmlS3Key: varchar('listing_html_s3_key', { length: 500 }),
    /** Copy of resolved `statute_id:section_key` pairs, for filtering without a join. */
    normalizedSectionKeys: json('normalized_section_keys').$type<string[]>().notNull(),
    extractionStatus: mysqlEnum('extraction_status', EXTRACTION_STATUSES).notNull().default('NEEDS_REVIEW'),
    lastSyncedAt: dt('last_synced_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('uq_judgments_natural').on(t.source, t.issueNumber, t.division, t.serialNumber),
    index('ix_judgments_decision').on(t.decisionDate),
    index('ix_judgments_status').on(t.extractionStatus),
  ],
);

/** Judgment → statute section links (SRS 5.8). `statute_id` NULL = an Act the dictionary didn't resolve. */
export const judgmentStatuteRefs = mysqlTable(
  'judgment_statute_refs',
  {
    referenceId: uuidBin('reference_id').primaryKey(),
    judgmentId: uuidBin('judgment_id')
      .notNull()
      .references(() => judgments.judgmentId, { onDelete: 'cascade' }),
    statuteId: uuidBin('statute_id').references(() => statutes.statuteId),
    normalizedSectionKey: varchar('normalized_section_key', { length: 16 }),
    rawReferenceText: text('raw_reference_text').notNull(),
    paragraphNumbers: json('paragraph_numbers').$type<string[]>().notNull(),
    foundIn: mysqlEnum('found_in', JUDGMENT_REF_SOURCES).notNull(),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index('ix_jrefs_section').on(t.statuteId, t.normalizedSectionKey), index('ix_jrefs_judgment').on(t.judgmentId)],
);

/** Paragraph-aware chunks mirrored to the Qdrant collection `judgment_chunks` (TRD §4.4, §6A.4). */
export const judgmentChunks = mysqlTable(
  'judgment_chunks',
  {
    chunkId: uuidBin('chunk_id').primaryKey(),
    judgmentId: uuidBin('judgment_id')
      .notNull()
      .references(() => judgments.judgmentId, { onDelete: 'cascade' }),
    chunkIndex: smallint('chunk_index').notNull(),
    paragraphFrom: smallint('paragraph_from'),
    paragraphTo: smallint('paragraph_to'),
    chunkText: text('chunk_text').notNull(),
    embeddingModel: varchar('embedding_model', { length: 64 }),
    indexedAt: dt('indexed_at'),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [uniqueIndex('uq_jchunks_judgment_idx').on(t.judgmentId, t.chunkIndex)],
);

/** Old text of a judgment whose PDF changed at the same URL (FR-D4). */
export const judgmentRevisions = mysqlTable(
  'judgment_revisions',
  {
    revisionId: uuidBin('revision_id').primaryKey(),
    judgmentId: uuidBin('judgment_id')
      .notNull()
      .references(() => judgments.judgmentId, { onDelete: 'cascade' }),
    pdfSha256: varchar('pdf_sha256', { length: 64 }),
    storedPdfKey: varchar('stored_pdf_key', { length: 500 }),
    fullText: mediumtext('full_text'),
    replacedAt: dt('replaced_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index('ix_jrev_judgment').on(t.judgmentId)],
);
