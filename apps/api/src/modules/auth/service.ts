import { auditLog, newId, otpChallenges, refreshTokens, users, type Db, type UserRole } from '@lawassist/db';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { ApiError } from '../../problem';
import { normalizeContact } from './contact';
import { codeMatches, generateCode, hashCode, hashRefreshToken, newRefreshToken, OTP_POLICY, type OtpSender } from './otp';
import { TOKEN_POLICY, type TokenService } from './tokens';

type UserRow = typeof users.$inferSelect;

export interface Session {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: UserRow;
}

export interface AuthServiceDeps {
  db: Db;
  tokens: TokenService;
  sender: OtpSender;
  otpKey: string;
  now?: () => Date;
}

const seconds = (n: number) => n * 1000;

/**
 * OTP login, sessions and the caller's own profile (TRD §12.1, App Flow §3; BE-03/BE-04).
 * Every race-sensitive step (attempt counting, consuming a code, rotating a refresh token) is a
 * conditional UPDATE whose affected-row count decides the outcome, so concurrent requests can't
 * both succeed.
 */
export class AuthService {
  private readonly now: () => Date;

  constructor(private readonly d: AuthServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async requestOtp(rawContact: string, language: 'BN' | 'EN') {
    const contact = normalizeContact(rawContact);
    if (!contact) throw new ApiError(422, 'INVALID_CONTACT', 'Enter a Bangladeshi mobile number or an email address');
    const now = this.now();

    const recent = await this.d.db
      .select({ createdAt: otpChallenges.createdAt })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.contactIdentifier, contact.identifier), gt(otpChallenges.createdAt, new Date(now.getTime() - seconds(OTP_POLICY.windowSeconds)))))
      .orderBy(desc(otpChallenges.createdAt));
    const last = recent[0]?.createdAt;
    if (last && now.getTime() - last.getTime() < seconds(OTP_POLICY.resendAfterSeconds)) {
      const wait = Math.ceil((seconds(OTP_POLICY.resendAfterSeconds) - (now.getTime() - last.getTime())) / 1000);
      throw new ApiError(429, 'OTP_RESEND_TOO_SOON', 'Please wait before requesting another code', `Try again in ${wait} s`);
    }
    if (recent.length >= OTP_POLICY.maxPerWindow) {
      throw new ApiError(429, 'OTP_RATE_LIMITED', 'Too many codes requested', 'Try again in 10 minutes');
    }

    const challengeId = newId();
    const code = generateCode();
    await this.d.db.insert(otpChallenges).values({
      challengeId,
      contactIdentifier: contact.identifier,
      channel: contact.channel,
      codeHash: hashCode(this.d.otpKey, challengeId, code),
      expiresAt: new Date(now.getTime() + seconds(OTP_POLICY.ttlSeconds)),
      createdAt: now,
    });
    let delivery: 'SENT' | 'DEV_CONSOLE';
    try {
      delivery = (await this.d.sender.send({ channel: contact.channel, to: contact.identifier, code, language })) ?? 'SENT';
    } catch {
      await this.d.db.delete(otpChallenges).where(eq(otpChallenges.challengeId, challengeId));
      throw new ApiError(503, 'OTP_DELIVERY_FAILED', 'Could not send the code', 'Please try again');
    }
    return { challengeId, channel: contact.channel, delivery };
  }

  /** Checks the code; signs the user in, creating the account on first login (role CITIZEN). */
  async verifyOtp(challengeId: string, code: string, language: 'BN' | 'EN'): Promise<Session & { isNewUser: boolean }> {
    const db = this.d.db;
    const now = this.now();
    const [ch] = await db.select().from(otpChallenges).where(eq(otpChallenges.challengeId, challengeId));
    if (!ch || ch.consumedAt) throw new ApiError(400, 'OTP_INVALID', 'Incorrect or used code');
    if (ch.expiresAt <= now) throw new ApiError(400, 'OTP_EXPIRED', 'This code has expired', 'Request a new code');

    const [counted] = await db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(and(eq(otpChallenges.challengeId, challengeId), isNull(otpChallenges.consumedAt), lt(otpChallenges.attempts, OTP_POLICY.maxAttempts)));
    if (counted.affectedRows !== 1) throw new ApiError(400, 'OTP_TOO_MANY_ATTEMPTS', 'Too many wrong codes', 'Request a new code');

    if (!codeMatches(this.d.otpKey, challengeId, code, ch.codeHash)) {
      const left = OTP_POLICY.maxAttempts - (ch.attempts + 1);
      throw new ApiError(400, 'OTP_INVALID', 'Incorrect or used code', left > 0 ? `${left} attempts left` : 'Request a new code');
    }
    const [consumed] = await db
      .update(otpChallenges)
      .set({ consumedAt: now })
      .where(and(eq(otpChallenges.challengeId, challengeId), isNull(otpChallenges.consumedAt)));
    if (consumed.affectedRows !== 1) throw new ApiError(400, 'OTP_INVALID', 'Incorrect or used code');

    let user = await this.userByContact(ch.contactIdentifier);
    let isNewUser = false;
    if (!user) {
      try {
        await db.insert(users).values({ userId: newId(), fullName: '', contactIdentifier: ch.contactIdentifier, preferredLanguage: language });
        isNewUser = true;
      } catch (err) {
        // A concurrent first login for the same contact created the row; use it.
        if ((err as { cause?: { errno?: number } }).cause?.errno !== 1062) throw err;
      }
      user = await this.userByContact(ch.contactIdentifier);
    }
    if (!user) throw new Error('user row missing after insert');
    if (user.deletedAt) throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account has been deleted');
    return { ...(await this.startSession(user)), isNewUser };
  }

  /**
   * Rotates a refresh token (TRD §12.1). Presenting an already-rotated token means it was copied:
   * the whole family (session) is revoked and the caller must sign in again.
   */
  async refresh(token: string): Promise<Session> {
    const db = this.d.db;
    const now = this.now();
    const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashRefreshToken(token)));
    if (!row || row.revokedAt) throw new ApiError(401, 'REFRESH_INVALID', 'Session expired', 'Sign in again');
    if (row.rotatedAt) {
      await this.revokeFamily(row.familyId);
      throw new ApiError(401, 'REFRESH_REUSED', 'Session ended for safety', 'Sign in again');
    }
    if (row.expiresAt <= now) throw new ApiError(401, 'REFRESH_EXPIRED', 'Session expired', 'Sign in again');

    const [rotated] = await db
      .update(refreshTokens)
      .set({ rotatedAt: now })
      .where(and(eq(refreshTokens.tokenId, row.tokenId), isNull(refreshTokens.rotatedAt), isNull(refreshTokens.revokedAt)));
    if (rotated.affectedRows !== 1) {
      // Lost a race with another use of the same token: treat it as reuse.
      await this.revokeFamily(row.familyId);
      throw new ApiError(401, 'REFRESH_REUSED', 'Session ended for safety', 'Sign in again');
    }
    const [user] = await db.select().from(users).where(eq(users.userId, row.userId));
    if (!user || user.deletedAt) throw new ApiError(401, 'REFRESH_INVALID', 'Session expired', 'Sign in again');
    // Role and verification are re-read here, so an approval takes effect at the next refresh.
    return this.startSession(user, row.familyId);
  }

  async logout(sessionId: string): Promise<void> {
    await this.revokeFamily(sessionId);
  }

  async me(userId: string): Promise<UserRow> {
    const [user] = await this.d.db.select().from(users).where(and(eq(users.userId, userId), isNull(users.deletedAt)));
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in required');
    return user;
  }

  async updateMe(userId: string, patch: { fullName?: string | undefined; preferredLanguage?: 'BN' | 'EN' | undefined }): Promise<UserRow> {
    const set: Partial<typeof users.$inferInsert> = {};
    if (patch.fullName !== undefined) set.fullName = patch.fullName;
    if (patch.preferredLanguage !== undefined) set.preferredLanguage = patch.preferredLanguage;
    if (Object.keys(set).length) await this.d.db.update(users).set(set).where(and(eq(users.userId, userId), isNull(users.deletedAt)));
    return this.me(userId);
  }

  /**
   * A Citizen asks to become a Lawyer or Judge (App Flow §3). The role stays CITIZEN with status
   * PENDING until an admin approves (BE-40). Allowed once; again only after a rejection.
   */
  async submitCredential(userId: string, requestedRole: Extract<UserRole, 'LAWYER' | 'JUDGE'>, credential: string): Promise<UserRow> {
    const db = this.d.db;
    const [res] = await db
      .update(users)
      .set({ requestedRole, verificationCredential: credential, verificationStatus: 'PENDING' })
      .where(
        and(
          eq(users.userId, userId),
          isNull(users.deletedAt),
          eq(users.role, 'CITIZEN'),
          sql`${users.verificationStatus} IN ('NOT_REQUIRED', 'REJECTED')`,
        ),
      );
    if (res.affectedRows !== 1) {
      const user = await this.me(userId);
      if (user.verificationStatus === 'PENDING') throw new ApiError(409, 'CREDENTIAL_PENDING', 'A credential is already under review');
      throw new ApiError(409, 'ROLE_LOCKED', 'Your role is already set', 'Contact support to change it');
    }
    // The credential number itself is personal data; the audit row records the event, not the value.
    await db.insert(auditLog).values({ actorUserId: userId, action: 'CREDENTIAL_SUBMITTED', entity: 'users', entityId: userId, details: { requestedRole } });
    return this.me(userId);
  }

  private async userByContact(identifier: string): Promise<UserRow | undefined> {
    const [user] = await this.d.db.select().from(users).where(eq(users.contactIdentifier, identifier));
    return user;
  }

  private async startSession(user: UserRow, familyId: string = newId()): Promise<Session> {
    const now = this.now();
    const { token, hash } = newRefreshToken();
    const refreshExpiresAt = new Date(now.getTime() + seconds(TOKEN_POLICY.refreshTtlSeconds));
    await this.d.db.insert(refreshTokens).values({ tokenId: newId(), userId: user.userId, familyId, tokenHash: hash, expiresAt: refreshExpiresAt, createdAt: now });
    const accessToken = await this.d.tokens.signAccess({ sub: user.userId, role: user.role, vs: user.verificationStatus, sid: familyId });
    return { accessToken, refreshToken: token, refreshExpiresAt, user };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.d.db.update(refreshTokens).set({ revokedAt: this.now() }).where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }
}
