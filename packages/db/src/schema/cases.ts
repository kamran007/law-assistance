import { sql } from 'drizzle-orm';
import {
  date,
  double,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { dt, timestamps, uuidBin } from './columns';
import {
  ARTIFACT_TYPES,
  INPUT_MODES,
  LANGUAGES,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
  PROCESSING_STATUSES,
} from './enums';
import { users } from './users';

/*
 * TENANT-OWNED TABLES. Every row carries owner_user_id and must only be accessed through
 * the scoped repository (src/scoped.ts) — enforced by ESLint (TRD §4.3).
 */

/** SRS 5.5 */
export const caseFiles = mysqlTable(
  'case_files',
  {
    caseFileId: uuidBin('case_file_id').primaryKey(),
    ownerUserId: uuidBin('owner_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    title: varchar('title', { length: 300 }),
    caseNumber: varchar('case_number', { length: 200 }),
    courtOrThana: varchar('court_or_thana', { length: 200 }),
    allegedOffenseDate: date('alleged_offense_date', { mode: 'string' }),
    version: int('version').notNull().default(1),
    ...timestamps,
    deletedAt: dt('deleted_at'),
  },
  (t) => [index('ix_cases_owner_updated').on(t.ownerUserId, t.updatedAt)],
);

/** SRS 5.6 + TRD §4.2 changes. */
export const caseArtifacts = mysqlTable(
  'case_artifacts',
  {
    artifactId: uuidBin('artifact_id').primaryKey(),
    caseFileId: uuidBin('case_file_id')
      .notNull()
      .references(() => caseFiles.caseFileId, { onDelete: 'cascade' }),
    ownerUserId: uuidBin('owner_user_id').notNull(),
    artifactType: mysqlEnum('artifact_type', ARTIFACT_TYPES).notNull(),
    templateKey: varchar('template_key', { length: 64 }),
    fileStorageKey: varchar('file_storage_key', { length: 500 }),
    mimeType: varchar('mime_type', { length: 100 }),
    fileSha256: varchar('file_sha256', { length: 64 }),
    pageCount: int('page_count'),
    processingStatus: mysqlEnum('processing_status', PROCESSING_STATUSES),
    processingError: text('processing_error'),
    ocrConfidence: double('ocr_confidence'),
    rawExtractedText: mediumtext('raw_extracted_text'),
    structuredAnalysis: json('structured_analysis'),
    roleAnalysis: json('role_analysis'),
    editableDocumentHtml: mediumtext('editable_document_html'),
    version: int('version').notNull().default(1),
    ...timestamps,
    deletedAt: dt('deleted_at'),
  },
  (t) => [
    index('ix_artifacts_owner_case').on(t.ownerUserId, t.caseFileId),
    index('ix_artifacts_owner_updated').on(t.ownerUserId, t.updatedAt),
  ],
);

/** Preserved copies on sync conflicts (App Flow §13, TRD §5.4). */
export const artifactRevisions = mysqlTable(
  'artifact_revisions',
  {
    revisionId: uuidBin('revision_id').primaryKey(),
    artifactId: uuidBin('artifact_id')
      .notNull()
      .references(() => caseArtifacts.artifactId, { onDelete: 'cascade' }),
    ownerUserId: uuidBin('owner_user_id').notNull(),
    version: int('version').notNull(),
    editableDocumentHtml: mediumtext('editable_document_html'),
    createdByDevice: varchar('created_by_device', { length: 100 }),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index('ix_revisions_owner_artifact').on(t.ownerUserId, t.artifactId)],
);

/**
 * Conversations (App Flow §4, §5.2). case_file_id NULL = general conversation.
 * UNIQUE(case_file_id): one conversation per case (MySQL UNIQUE allows many NULLs).
 * A trigger (custom migration) rejects case conversations for CITIZEN owners.
 */
export const conversations = mysqlTable(
  'conversations',
  {
    conversationId: uuidBin('conversation_id').primaryKey(),
    ownerUserId: uuidBin('owner_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    caseFileId: uuidBin('case_file_id').references(() => caseFiles.caseFileId, { onDelete: 'cascade' }),
    title: varchar('title', { length: 300 }),
    language: mysqlEnum('language', LANGUAGES).notNull().default('BN'),
    summary: mediumtext('summary'),
    ...timestamps,
    deletedAt: dt('deleted_at'),
  },
  (t) => [
    uniqueIndex('uq_conversations_case').on(t.caseFileId),
    index('ix_conversations_owner_updated').on(t.ownerUserId, t.updatedAt),
  ],
);

export interface MessageCitation {
  sectionId: string;
  label: string;
}

export const messages = mysqlTable(
  'messages',
  {
    messageId: uuidBin('message_id').primaryKey(),
    conversationId: uuidBin('conversation_id')
      .notNull()
      .references(() => conversations.conversationId, { onDelete: 'cascade' }),
    ownerUserId: uuidBin('owner_user_id').notNull(),
    role: mysqlEnum('role', MESSAGE_ROLES).notNull(),
    content: mediumtext('content').notNull(),
    inputMode: mysqlEnum('input_mode', INPUT_MODES).notNull().default('TEXT'),
    attachedArtifactId: uuidBin('attached_artifact_id').references(() => caseArtifacts.artifactId, {
      onDelete: 'set null',
    }),
    citations: json('citations').$type<MessageCitation[]>(),
    retrievalTrace: json('retrieval_trace'),
    lawAsOfDate: date('law_as_of_date', { mode: 'string' }),
    modelId: varchar('model_id', { length: 64 }),
    inputTokens: int('input_tokens'),
    outputTokens: int('output_tokens'),
    latencyMs: int('latency_ms'),
    status: mysqlEnum('status', MESSAGE_STATUSES).notNull().default('COMPLETE'),
    flags: json('flags').$type<string[]>(),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index('ix_messages_conversation_created').on(t.conversationId, t.createdAt),
    index('ix_messages_owner').on(t.ownerUserId),
  ],
);
