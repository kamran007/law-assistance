import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Channel } from './contact';

/** TRD §12.1: 6 digits, 5 min TTL, at most 5 attempts. TRD §5.5: 3 per 10 min per identifier. */
export const OTP_POLICY = {
  digits: 6,
  ttlSeconds: 5 * 60,
  maxAttempts: 5,
  resendAfterSeconds: 60,
  maxPerWindow: 3,
  windowSeconds: 10 * 60,
} as const;

export function generateCode(): string {
  return String(randomInt(0, 10 ** OTP_POLICY.digits)).padStart(OTP_POLICY.digits, '0');
}

/** HMAC bound to the challenge, so a hash can't be replayed against another challenge. */
export function hashCode(key: string, challengeId: string, code: string): string {
  return createHmac('sha256', key).update(`${challengeId}:${code}`).digest('hex');
}

export function codeMatches(key: string, challengeId: string, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(key, challengeId, code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Opaque refresh token (256 bits) and the hash stored in `refresh_tokens.token_hash`. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/** High-entropy random tokens don't need a keyed hash; SHA-256 keeps the DB useless if leaked. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface OtpMessage {
  channel: Channel;
  to: string;
  code: string;
  language: 'BN' | 'EN';
}

/**
 * How a code reached the user: `SENT` by SMS / email, or `DEV_CONSOLE` = only printed to the API's
 * terminal (local development), so the app can say so instead of "we sent you an email".
 */
export type OtpDelivery = 'SENT' | 'DEV_CONSOLE';

/** Delivers one-time codes. Throwing = not delivered (the API answers 503 OTP_DELIVERY_FAILED). */
export interface OtpSender {
  /** Resolving without a value means SENT. */
  send(msg: OtpMessage): Promise<OtpDelivery | void>;
}

/** Sends each channel through its own sender; a channel without one fails. */
export class ChannelOtpSender implements OtpSender {
  constructor(private readonly senders: Partial<Record<Channel, OtpSender>>) {}

  async send(msg: OtpMessage): Promise<OtpDelivery | void> {
    const sender = this.senders[msg.channel];
    if (!sender) throw new Error(`No ${msg.channel} sender configured`);
    return sender.send(msg);
  }
}

/**
 * Development only (config refuses it in staging/production): prints the code to stdout so a
 * developer can sign in locally. Deliberately bypasses the structured logger, so codes never reach
 * log storage.
 */
export class ConsoleOtpSender implements OtpSender {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {}

  async send(msg: OtpMessage): Promise<OtpDelivery> {
    this.write(`[dev OTP] ${msg.channel} ${msg.to}: ${msg.code}`);
    return 'DEV_CONSOLE';
  }
}
