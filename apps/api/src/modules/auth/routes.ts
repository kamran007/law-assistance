import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { toAsciiDigits } from '@lawassist/legal-text';
import { z } from 'zod';
import { requireAuth, type Authenticate } from '../../auth';
import { ApiError } from '../../problem';
import { maskContact } from './contact';
import { OTP_POLICY } from './otp';
import type { AuthService, Session } from './service';
import { TOKEN_POLICY } from './tokens';

export interface AuthRoutesDeps {
  service: AuthService;
  authenticate: Authenticate;
  /** `Secure` cookie flag; off only for plain-http local development. */
  secureCookies: boolean;
}

/** Web keeps the refresh token in this HttpOnly cookie, scoped to the refresh route (TRD §12.1). */
export const REFRESH_COOKIE = 'la_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth/refresh';

const language = z.enum(['BN', 'EN']);
const client = z.enum(['web', 'mobile']).default('mobile');

const me = z.object({
  user_id: z.string(),
  full_name: z.string(),
  contact: z.string(),
  role: z.enum(['CITIZEN', 'LAWYER', 'JUDGE', 'ADMIN']),
  requested_role: z.enum(['CITIZEN', 'LAWYER', 'JUDGE', 'ADMIN']),
  verification_status: z.enum(['NOT_REQUIRED', 'PENDING', 'VERIFIED', 'REJECTED']),
  preferred_language: language,
  /** False until the user has entered their name (new accounts go to Profile Setup). */
  profile_complete: z.boolean(),
});

const session = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  /** Mobile only. Web receives it as an HttpOnly cookie instead. */
  refresh_token: z.string().optional(),
  refresh_expires_at: z.string(),
  is_new_user: z.boolean().optional(),
  user: me,
});

const verifyBody = z.object({
  challenge_id: z.uuid(),
  /** 6 digits; Bangla digits accepted. */
  code: z.string().trim().transform((s) => toAsciiDigits(s)).pipe(z.string().regex(/^\d{6}$/, 'must be 6 digits')),
  language: language.default('BN'),
  client,
});

const toMe = (u: Session['user']): z.infer<typeof me> => ({
  user_id: u.userId,
  full_name: u.fullName,
  contact: u.contactIdentifier,
  role: u.role,
  requested_role: u.requestedRole,
  verification_status: u.verificationStatus,
  preferred_language: u.preferredLanguage,
  profile_complete: u.fullName.trim().length > 0,
});

/** OTP login, sessions and the caller's profile (TRD §5.1, §12.1; BE-03/BE-04). */
export const authRoutes =
  (deps: AuthRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { service } = deps;

    const sendSession = (reply: FastifyReply, s: Session, as: 'web' | 'mobile', extra: { is_new_user?: boolean } = {}) => {
      if (as === 'web') {
        reply.setCookie(REFRESH_COOKIE, s.refreshToken, {
          httpOnly: true,
          secure: deps.secureCookies,
          sameSite: 'strict',
          path: REFRESH_COOKIE_PATH,
          expires: s.refreshExpiresAt,
        });
      }
      return {
        access_token: s.accessToken,
        token_type: 'Bearer' as const,
        expires_in: TOKEN_POLICY.accessTtlSeconds,
        ...(as === 'mobile' ? { refresh_token: s.refreshToken } : {}),
        refresh_expires_at: s.refreshExpiresAt.toISOString(),
        ...extra,
        user: toMe(s.user),
      };
    };

    app.post(
      '/auth/otp/request',
      {
        // TRD §5.5: 10 per hour per IP here; 3 per 10 min per identifier is enforced in the service.
        config: { access: 'public', rateLimit: { max: 10, timeWindow: '1 hour' } },
        schema: {
          tags: ['auth'],
          summary: 'Send a one-time code by SMS or email',
          body: z.object({ contact: z.string().min(3).max(254), language: language.default('BN') }),
          response: {
            202: z.object({
              challenge_id: z.string(),
              channel: z.enum(['SMS', 'EMAIL']),
              /** DEV_CONSOLE: local development, the code was printed to the API's terminal, not sent. */
              delivery: z.enum(['SENT', 'DEV_CONSOLE']),
              expires_in_s: z.number().int(),
              resend_after_s: z.number().int(),
            }),
          },
        },
      },
      async (req, reply) => {
        const { challengeId, channel, delivery } = await service.requestOtp(req.body.contact, req.body.language);
        req.log.info({ channel, challengeId }, 'otp requested');
        return reply.status(202).send({ challenge_id: challengeId, channel, delivery, expires_in_s: OTP_POLICY.ttlSeconds, resend_after_s: OTP_POLICY.resendAfterSeconds });
      },
    );

    const verify = async (body: z.infer<typeof verifyBody>, reply: FastifyReply) => {
      const s = await service.verifyOtp(body.challenge_id, body.code, body.language);
      reply.log.info({ userId: s.user.userId, contact: maskContact(s.user.contactIdentifier), isNewUser: s.isNewUser }, 'signed in');
      return sendSession(reply, s, body.client, { is_new_user: s.isNewUser });
    };
    const verifyOpts = (summary: string) => ({
      config: { access: 'public' as const, rateLimit: { max: 30, timeWindow: '10 minutes' } },
      schema: { tags: ['auth'], summary, body: verifyBody, response: { 200: session } },
    });
    app.post('/auth/otp/verify', verifyOpts('Verify the code and sign in (creates the account on first login)'), async (req, reply) => verify(req.body, reply));
    // SRS §6 names this endpoint; it is the same operation (TRD §5.1).
    app.post('/auth/login', verifyOpts('Alias of /auth/otp/verify'), async (req, reply) => verify(req.body, reply));

    app.post(
      '/auth/refresh',
      {
        config: { access: 'public', rateLimit: { max: 60, timeWindow: '10 minutes' } },
        schema: {
          tags: ['auth'],
          summary: 'Rotate the refresh token (body for mobile, cookie for web)',
          // Web sends no body (the cookie carries the token); Fastify hands that over as null.
          body: z.object({ refresh_token: z.string().min(20).max(200).optional() }).nullish(),
          response: { 200: session },
        },
      },
      async (req, reply) => {
        const fromBody = req.body?.refresh_token;
        const fromCookie = req.cookies[REFRESH_COOKIE];
        const token = fromBody ?? fromCookie;
        if (!token) throw new ApiError(401, 'REFRESH_INVALID', 'Session expired', 'Sign in again');
        try {
          return sendSession(reply, await service.refresh(token), fromBody ? 'mobile' : 'web');
        } catch (err) {
          if (!fromBody) reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
          throw err;
        }
      },
    );

    app.post(
      '/auth/logout',
      { config: { access: 'self' }, schema: { tags: ['auth'], summary: 'End this login session on every device that shares it', response: { 204: z.null() } } },
      async (req, reply) => {
        const p = requireAuth(await deps.authenticate(req));
        if (p.sessionId) await service.logout(p.sessionId);
        reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
        return reply.status(204).send(null);
      },
    );

    app.get('/me', { config: { access: 'self' }, schema: { tags: ['me'], summary: 'My profile and verification status', response: { 200: me } } }, async (req) => {
      const p = requireAuth(await deps.authenticate(req));
      return toMe(await service.me(p.userId));
    });

    app.patch(
      '/me',
      {
        config: { access: 'self' },
        schema: {
          tags: ['me'],
          summary: 'Update my name or language (the role cannot be changed here)',
          body: z.object({ full_name: z.string().trim().min(2).max(200).optional(), preferred_language: language.optional() }).strict(),
          response: { 200: me },
        },
      },
      async (req) => {
        const p = requireAuth(await deps.authenticate(req));
        return toMe(await service.updateMe(p.userId, { fullName: req.body.full_name, preferredLanguage: req.body.preferred_language }));
      },
    );

    app.post(
      '/me/credential',
      {
        config: { access: 'self' },
        schema: {
          tags: ['me'],
          summary: 'Submit a Bar Council enrollment number or Judicial ID for verification',
          body: z.object({
            requested_role: z.enum(['LAWYER', 'JUDGE']),
            credential: z
              .string()
              .trim()
              .min(3)
              .max(50)
              .regex(/^[\p{L}\p{N} /.-]+$/u, 'letters, digits, spaces, / . - only'),
          }),
          response: { 200: me },
        },
      },
      async (req) => {
        const p = requireAuth(await deps.authenticate(req));
        return toMe(await service.submitCredential(p.userId, req.body.requested_role, req.body.credential));
      },
    );
  };
