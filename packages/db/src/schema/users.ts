import { sql } from 'drizzle-orm';
import { index, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { dt, timestamps, uuidBin } from './columns';
import { CREDENTIAL_DECISIONS, LANGUAGES, OTP_CHANNELS, USER_ROLES, VERIFICATION_STATUSES } from './enums';

/** SRS 5.1 + TRD §4.2 additions. */
export const users = mysqlTable(
  'users',
  {
    userId: uuidBin('user_id').primaryKey(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    contactIdentifier: varchar('contact_identifier', { length: 254 }).notNull(),
    /** Effective role. Stays CITIZEN until a LAWYER/JUDGE credential is VERIFIED. */
    role: mysqlEnum('role', USER_ROLES).notNull().default('CITIZEN'),
    requestedRole: mysqlEnum('requested_role', USER_ROLES).notNull().default('CITIZEN'),
    verificationCredential: varchar('verification_credential', { length: 100 }),
    verificationStatus: mysqlEnum('verification_status', VERIFICATION_STATUSES).notNull().default('NOT_REQUIRED'),
    preferredLanguage: mysqlEnum('preferred_language', LANGUAGES).notNull().default('BN'),
    ...timestamps,
    deletedAt: dt('deleted_at'),
  },
  (t) => [uniqueIndex('uq_users_contact').on(t.contactIdentifier)],
);

export const otpChallenges = mysqlTable(
  'otp_challenges',
  {
    challengeId: uuidBin('challenge_id').primaryKey(),
    contactIdentifier: varchar('contact_identifier', { length: 254 }).notNull(),
    channel: mysqlEnum('channel', OTP_CHANNELS).notNull(),
    /** HMAC of the code — never the code itself. */
    codeHash: varchar('code_hash', { length: 128 }).notNull(),
    attempts: int('attempts').notNull().default(0),
    expiresAt: dt('expires_at').notNull(),
    consumedAt: dt('consumed_at'),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index('ix_otp_contact_created').on(t.contactIdentifier, t.createdAt)],
);

export const refreshTokens = mysqlTable(
  'refresh_tokens',
  {
    tokenId: uuidBin('token_id').primaryKey(),
    userId: uuidBin('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    /** Rotation family: reuse of a rotated token revokes the whole family. */
    familyId: uuidBin('family_id').notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    expiresAt: dt('expires_at').notNull(),
    rotatedAt: dt('rotated_at'),
    revokedAt: dt('revoked_at'),
    createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [uniqueIndex('uq_refresh_hash').on(t.tokenHash), index('ix_refresh_family').on(t.familyId)],
);

export const credentialReviews = mysqlTable('credential_reviews', {
  reviewId: uuidBin('review_id').primaryKey(),
  userId: uuidBin('user_id')
    .notNull()
    .references(() => users.userId, { onDelete: 'cascade' }),
  reviewerUserId: uuidBin('reviewer_user_id')
    .notNull()
    .references(() => users.userId),
  decision: mysqlEnum('decision', CREDENTIAL_DECISIONS).notNull(),
  note: varchar('note', { length: 500 }),
  createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});
