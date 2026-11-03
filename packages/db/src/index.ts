/**
 * Public entry point for apps. Tenant-owned tables are reachable only via `scoped()`.
 * Public (non-tenant) tables — statutes, sections, schedule, users, auth, ops — are re-exported
 * for modules that need them (auth, statutes, scraper, admin).
 */
export { createDb, type Db } from './client';
export { runMigrations, MIGRATIONS_FOLDER } from './migrate';
export { scoped, type ScopedRepos, type UpdateResult, type CaseFile, type Conversation, type Message, type CaseArtifact } from './scoped';
export {
  users,
  otpChallenges,
  refreshTokens,
  credentialReviews,
  statutes,
  statuteSections,
  sectionChunks,
  crpcScheduleMetadata,
  scrapeRuns,
  scrapeEvents,
  outboxEvents,
  auditLog,
  newId,
  uuidToBuffer,
  bufferToUuid,
} from './schema/index';
export * from './schema/enums';
