import { createSign } from 'node:crypto';
import { z } from 'zod';
import type { PushNotifier } from './artifact-events';

/**
 * Push notifications via Firebase Cloud Messaging, HTTP v1 API (BE-26 / MOB-07).
 *
 * Authenticates with a Google service account (OAuth 2.0 JWT bearer grant, signed here with
 * node:crypto, so no Firebase SDK). The message says only that a document finished and carries the
 * artifact id for the app to open it; no document content, names or sections ever leave in a push.
 * Tokens FCM reports as gone (UNREGISTERED, SENDER_ID_MISMATCH) are removed from the store.
 */

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const ServiceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  client_email: z.string().email(),
  private_key: z.string().includes('PRIVATE KEY'),
  token_uri: z.string().url().default('https://oauth2.googleapis.com/token'),
});
export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;

/** Parses a service-account JSON key. Errors name the fields, never echo values. */
export function parseServiceAccount(json: string): ServiceAccount {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('FCM service account: not valid JSON');
  }
  const r = ServiceAccountSchema.safeParse(raw);
  if (!r.success) throw new Error(`FCM service account: invalid ${r.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return r.data;
}

/** Where the notifier finds a user's devices and language. Implemented over `scoped(db, userId).devices`. */
export interface PushTokenStore {
  forUser(userId: string): Promise<{ language: 'BN' | 'EN'; tokens: string[] }>;
  remove(userId: string, token: string): Promise<void>;
}

/** Generic texts only; the app shows details after opening the document. */
export const PUSH_TEXT = {
  BN: {
    READY: { title: 'বিশ্লেষণ প্রস্তুত', body: 'আপনার নথির বিশ্লেষণ সম্পন্ন হয়েছে। দেখতে ট্যাপ করুন।' },
    FAILED: { title: 'বিশ্লেষণ করা যায়নি', body: 'নথিটি বিশ্লেষণ করা যায়নি। আবার চেষ্টা করতে ট্যাপ করুন।' },
  },
  EN: {
    READY: { title: 'Analysis ready', body: 'Your document has been analysed. Tap to view.' },
    FAILED: { title: 'Analysis failed', body: 'We could not analyse your document. Tap to try again.' },
  },
} as const;

/** FCM error codes that mean the token will never work again. */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);

export class FcmSendError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly errorCode: string | null,
  ) {
    super(`FCM send failed: HTTP ${httpStatus}${errorCode ? ` ${errorCode}` : ''}`);
    this.name = 'FcmSendError';
  }
}

export interface FcmOptions {
  serviceAccount: ServiceAccount;
  store: PushTokenStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export class FcmPushNotifier implements PushNotifier {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(private readonly opts: FcmOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async documentFinished(n: { userId: string; artifactId: string; status: 'READY' | 'FAILED' }): Promise<void> {
    const { language, tokens } = await this.opts.store.forUser(n.userId);
    if (tokens.length === 0) return;
    const text = PUSH_TEXT[language][n.status];
    const results = await Promise.allSettled(
      tokens.map((token) =>
        this.send({
          token,
          notification: text,
          data: { type: 'DOCUMENT_FINISHED', artifact_id: n.artifactId, status: n.status },
          android: { priority: 'HIGH', notification: { tag: n.artifactId } },
          apns: { headers: { 'apns-collapse-id': n.artifactId }, payload: { aps: { sound: 'default' } } },
        }),
      ),
    );
    const failures: FcmSendError[] = [];
    for (const [i, r] of results.entries()) {
      if (r.status === 'fulfilled') continue;
      const err = r.reason instanceof FcmSendError ? r.reason : new FcmSendError(0, null);
      if (err.errorCode && DEAD_TOKEN_CODES.has(err.errorCode)) await this.opts.store.remove(n.userId, tokens[i]!);
      else failures.push(err);
    }
    // Every device failed for a reason other than a dead token: surface it (the caller logs it).
    if (failures.length && failures.length === tokens.length) throw failures[0];
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    const access = await this.accessToken();
    const res = await this.fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.opts.serviceAccount.project_id)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.ok) return;
    if (res.status === 401) this.token = null; // revoked or expired early: fetch a new one next time
    throw new FcmSendError(res.status, await errorCode(res));
  }

  /** OAuth access token, cached until a minute before it expires; concurrent callers share one fetch. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    this.pendingToken ??= this.fetchAccessToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchAccessToken(): Promise<string> {
    const sa = this.opts.serviceAccount;
    const iat = Math.floor(this.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: FCM_SCOPE, aud: sa.token_uri, iat, exp: iat + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
    const res = await this.fetch(sa.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(signature)}` }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new FcmSendError(res.status, 'OAUTH_TOKEN');
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new FcmSendError(res.status, 'OAUTH_TOKEN');
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}

/** FCM v1 puts the specific code in `error.details[].errorCode`; falls back to `error.status`. */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { status?: string; details?: { errorCode?: string }[] } };
    return body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? null;
  } catch {
    return null;
  }
}
