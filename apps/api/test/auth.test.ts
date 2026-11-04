import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireProfessional } from '../src/auth';
import { ApiError } from '../src/problem';
import { jwtAuthenticate } from '../src/modules/auth/authenticate';
import { maskContact, normalizeContact } from '../src/modules/auth/contact';
import { codeMatches, ConsoleOtpSender, generateCode, hashCode, hashRefreshToken, newRefreshToken } from '../src/modules/auth/otp';
import { TOKEN_POLICY, TokenService } from '../src/modules/auth/tokens';

describe('normalizeContact', () => {
  it.each([
    ['01712345678', '+8801712345678'],
    ['01712-345678', '+8801712345678'],
    ['+880 1712 345678', '+8801712345678'],
    ['8801912345678', '+8801912345678'],
    ['008801312345678', '+8801312345678'],
    ['০১৭১২৩৪৫৬৭৮', '+8801712345678'],
  ])('phone %s → %s', (raw, identifier) => {
    expect(normalizeContact(raw)).toEqual({ identifier, channel: 'SMS' });
  });

  it('lower-cases emails', () => {
    expect(normalizeContact('  Advocate@Example.COM ')).toEqual({ identifier: 'advocate@example.com', channel: 'EMAIL' });
  });

  it.each(['01212345678', '0171234567', '+447911123456', 'not-an-email@', 'hello'])('rejects %s', (raw) => {
    expect(normalizeContact(raw)).toBeNull();
  });

  it('masks contacts for logs', () => {
    expect(maskContact('+8801712345678')).toBe('+88017…78');
    expect(maskContact('advocate@example.com')).toBe('a…@example.com');
  });
});

describe('one-time codes and refresh tokens', () => {
  const key = 'k'.repeat(32);

  it('generates 6-digit codes', () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it('binds the HMAC to the challenge and compares safely', () => {
    const h = hashCode(key, 'challenge-1', '123456');
    expect(codeMatches(key, 'challenge-1', '123456', h)).toBe(true);
    expect(codeMatches(key, 'challenge-1', '123457', h)).toBe(false);
    expect(codeMatches(key, 'challenge-2', '123456', h)).toBe(false);
    expect(codeMatches('x'.repeat(32), 'challenge-1', '123456', h)).toBe(false);
    expect(codeMatches(key, 'challenge-1', '123456', 'not-hex')).toBe(false);
  });

  it('stores only a hash of refresh tokens', () => {
    const { token, hash } = newRefreshToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(hash).toBe(hashRefreshToken(token));
    expect(hash).not.toContain(token);
  });

  it('prints dev codes with the console sender', async () => {
    const lines: string[] = [];
    await new ConsoleOtpSender((l) => lines.push(l)).send({ channel: 'SMS', to: '+8801712345678', code: '123456', language: 'BN' });
    expect(lines).toEqual(['[dev OTP] SMS +8801712345678: 123456']);
  });
});

describe('TokenService (ES256)', () => {
  const claims = { sub: 'user-1', role: 'LAWYER' as const, vs: 'VERIFIED' as const, sid: 'family-1' };

  it('signs and verifies access tokens, including PEM keys from env files', async () => {
    const { privatePem, publicPem } = await TokenService.generatePem();
    const escaped = (s: string) => s.replace(/\n/g, '\\n'); // how .env files carry PEM
    const t = await TokenService.fromPem(escaped(privatePem), escaped(publicPem));
    expect(await t.verifyAccess(await t.signAccess(claims))).toEqual(claims);
  });

  it('rejects expired tokens and tokens signed with another key', async () => {
    let now = new Date('2026-11-04T10:00:00Z');
    const t = await TokenService.ephemeral(() => now);
    const token = await t.signAccess(claims);
    now = new Date(now.getTime() + (TOKEN_POLICY.accessTtlSeconds + 1) * 1000);
    await expect(t.verifyAccess(token)).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
    const other = await TokenService.ephemeral(() => now);
    const foreign = await other.signAccess(claims);
    expect(await other.verifyAccess(foreign)).toEqual(claims);
    await expect(t.verifyAccess(foreign)).rejects.toMatchObject({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
  });

  it('maps the Authorization header to a principal or a 401', async () => {
    let now = new Date('2026-11-04T10:00:00Z');
    const t = await TokenService.ephemeral(() => now);
    const auth = jwtAuthenticate(t);
    const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as FastifyRequest;
    const token = await t.signAccess(claims);

    expect(await auth(req())).toBeNull();
    expect(await auth(req(`Bearer ${token}`))).toEqual({ userId: 'user-1', role: 'LAWYER', verificationStatus: 'VERIFIED', sessionId: 'family-1' });
    await expect(auth(req('Basic abc'))).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    await expect(auth(req(`Bearer ${token.slice(0, -4)}AAAA`))).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    now = new Date(now.getTime() + 16 * 60 * 1000);
    await expect(auth(req(`Bearer ${token}`))).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
  });
});

describe('requireProfessional for a professional under review', () => {
  it('tells a pending applicant (still CITIZEN) that verification is pending, not that the role is wrong', () => {
    try {
      requireProfessional({ userId: 'u', role: 'CITIZEN', verificationStatus: 'PENDING' }, 'x');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('VERIFICATION_REQUIRED');
    }
  });
});
