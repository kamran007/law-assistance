import { isProblem } from '@lawassist/contracts';

/** Error codes with their own message in `errors.*`; anything else shows `errors.generic`. */
export const KNOWN_ERRORS = [
  'INVALID_CONTACT',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_TOO_MANY_ATTEMPTS',
  'OTP_RESEND_TOO_SOON',
  'OTP_RATE_LIMITED',
  'OTP_DELIVERY_FAILED',
  'RATE_LIMITED',
  'ACCOUNT_DISABLED',
  'CREDENTIAL_PENDING',
  'ROLE_LOCKED',
  'VALIDATION_FAILED',
  'OFFENSE_DATE_IN_FUTURE',
  'VERSION_CONFLICT',
  'NOT_FOUND',
  'ARTIFACT_BUSY',
  'NOT_CORRECTABLE',
  'NETWORK',
] as const;
export type ErrorKey = (typeof KNOWN_ERRORS)[number] | 'generic';

export function errorKey(err: unknown): ErrorKey {
  if (err instanceof TypeError) return 'NETWORK'; // fetch rejects with TypeError when offline
  if (isProblem(err)) return (KNOWN_ERRORS as readonly string[]).includes(err.code) ? (err.code as ErrorKey) : 'generic';
  return 'generic';
}

/**
 * Only same-site relative paths are allowed as a post-login destination, so a crafted `next`
 * can't send the user to another site (open redirect).
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes(String.fromCodePoint(0x5c))) return '/'; // backslash: browsers treat /\ like //
  return next;
}
