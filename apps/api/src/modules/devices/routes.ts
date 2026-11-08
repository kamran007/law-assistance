import { DEVICE_PLATFORMS, scoped, type Db } from '@lawassist/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, type Authenticate } from '../../auth';

export interface DeviceRoutesDeps {
  db: Db;
  authenticate: Authenticate;
}

/** FCM registration tokens are opaque ASCII (base64url-ish plus ':'), typically ~160 characters. */
const fcmToken = z.string().regex(/^[\x21-\x7e]{20,512}$/, 'Not an FCM registration token');

/**
 * Push-notification devices (BE-26 push / MOB-07). The app registers its FCM token after sign-in
 * and on every token refresh, and removes it on sign-out. Acts on the caller's own account only.
 */
export const deviceRoutes =
  (deps: DeviceRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/me/devices',
      {
        config: { access: 'self' },
        schema: {
          tags: ['me'],
          summary: 'Register this device for push notifications (idempotent; also call on token refresh)',
          body: z.object({ token: fcmToken, platform: z.enum(DEVICE_PLATFORMS) }).strict(),
          response: { 204: z.null() },
        },
      },
      async (req, reply) => {
        const p = requireAuth(await deps.authenticate(req));
        await scoped(deps.db, p.userId).devices.register(req.body.token, req.body.platform);
        return reply.code(204).send(null);
      },
    );

    app.delete(
      '/me/devices',
      {
        config: { access: 'self' },
        schema: {
          tags: ['me'],
          summary: "Stop push notifications to this device (sign-out). Unknown tokens are ignored",
          body: z.object({ token: fcmToken }).strict(),
          response: { 204: z.null() },
        },
      },
      async (req, reply) => {
        const p = requireAuth(await deps.authenticate(req));
        await scoped(deps.db, p.userId).devices.remove(req.body.token);
        return reply.code(204).send(null);
      },
    );
  };
