import type { UserRole } from '@lawassist/db';
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Principal } from '../../auth';

/** TRD §12.1: access JWT 15 min, ES256; refresh token 30 days (opaque, rotated). */
export const TOKEN_POLICY = {
  accessTtlSeconds: 15 * 60,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  issuer: 'lawassist-api',
  audience: 'lawassist',
} as const;

const ALG = 'ES256';

export interface AccessClaims {
  sub: string;
  role: UserRole;
  /** verification_status */
  vs: Principal['verificationStatus'];
  /** Session = refresh-token family; logout revokes it. */
  sid: string;
}

export class TokenService {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
    private readonly now: () => Date,
  ) {}

  /** Keys are PEM (PKCS#8 private, SPKI public); env files may carry them `\n`-escaped. */
  static async fromPem(privatePem: string, publicPem: string, now: () => Date = () => new Date()): Promise<TokenService> {
    const unescape = (s: string) => s.replace(/\\n/g, '\n');
    return new TokenService(await importPKCS8(unescape(privatePem), ALG), await importSPKI(unescape(publicPem), ALG), now);
  }

  /** A throwaway key pair: local development (tokens die with the process) and tests. */
  static async ephemeral(now: () => Date = () => new Date()): Promise<TokenService> {
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    return new TokenService(privateKey, publicKey, now);
  }

  /** PEM pair for a fresh key (used by `pnpm --filter @lawassist/api keys` to fill `.env`). */
  static async generatePem(): Promise<{ privatePem: string; publicPem: string }> {
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    return { privatePem: await exportPKCS8(privateKey), publicPem: await exportSPKI(publicKey) };
  }

  async signAccess(c: AccessClaims): Promise<string> {
    const iat = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({ role: c.role, vs: c.vs, sid: c.sid })
      .setProtectedHeader({ alg: ALG, typ: 'JWT' })
      .setSubject(c.sub)
      .setJti(randomUUID())
      .setIssuer(TOKEN_POLICY.issuer)
      .setAudience(TOKEN_POLICY.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + TOKEN_POLICY.accessTtlSeconds)
      .sign(this.privateKey);
  }

  /** Throws on a bad signature, wrong issuer/audience, expiry or missing claims. */
  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      algorithms: [ALG],
      issuer: TOKEN_POLICY.issuer,
      audience: TOKEN_POLICY.audience,
      currentDate: this.now(),
    });
    const { sub, role, vs, sid } = payload as Partial<AccessClaims> & { sub?: string };
    if (!sub || !role || !vs || !sid) throw new Error('missing claims');
    return { sub, role, vs, sid };
  }
}
