import { toAsciiDigits } from '@lawassist/legal-text';
import { z } from 'zod';

export type Channel = 'SMS' | 'EMAIL';

export interface Contact {
  /** Canonical form stored in `users.contact_identifier`: E.164 phone or lower-case email. */
  identifier: string;
  channel: Channel;
}

/** Bangladeshi mobile numbers: +880 1[3-9] + 8 digits (operators 013–019). */
const BD_MOBILE = /^\+8801[3-9]\d{8}$/;
const email = z.email().max(254);

/**
 * Normalizes a phone number or email typed by the user (App Flow §3). Accepts local and
 * international phone formats, Bangla digits, spaces and dashes: "01712-345678", "+880 1712 345678",
 * "০১৭১২৩৪৫৬৭৮" → "+8801712345678". Returns null if it's neither a BD mobile number nor an email.
 */
export function normalizeContact(raw: string): Contact | null {
  const input = raw.normalize('NFC').trim();
  if (input.includes('@')) {
    const lower = input.toLowerCase();
    return email.safeParse(lower).success ? { identifier: lower, channel: 'EMAIL' } : null;
  }
  const digits = toAsciiDigits(input).replace(/[\s\-().]/g, '');
  let phone: string;
  if (/^01\d{9}$/.test(digits)) phone = `+88${digits}`;
  else if (/^8801\d{9}$/.test(digits)) phone = `+${digits}`;
  else if (/^\+8801\d{9}$/.test(digits)) phone = digits;
  else if (/^008801\d{9}$/.test(digits)) phone = `+${digits.slice(2)}`;
  else return null;
  return BD_MOBILE.test(phone) ? { identifier: phone, channel: 'SMS' } : null;
}

/** For logs: never the full contact (TRD §12.3). "+8801712345678" → "+88017…78", "a@b.com" → "a…@b.com". */
export function maskContact(identifier: string): string {
  const at = identifier.indexOf('@');
  if (at > 0) return `${identifier[0]}…${identifier.slice(at)}`;
  return `${identifier.slice(0, 6)}…${identifier.slice(-2)}`;
}
