import { readFileSync } from 'node:fs';
import type { AppConfig } from '@lawassist/config';
import { scoped, users, type Db } from '@lawassist/db';
import { FcmPushNotifier, noopPushNotifier, parseServiceAccount, type PushNotifier, type PushTokenStore } from '@lawassist/providers';
import { eq } from 'drizzle-orm';

/** Device tokens through the owner's scoped repo; the notification language follows the user's setting. */
export function dbPushTokenStore(db: Db): PushTokenStore {
  return {
    async forUser(userId) {
      const [user] = await db.select({ language: users.preferredLanguage }).from(users).where(eq(users.userId, userId)).limit(1);
      const tokens = user ? (await scoped(db, userId).devices.list()).map((d) => d.token) : [];
      return { language: user?.language ?? 'BN', tokens };
    },
    async remove(userId, token) {
      await scoped(db, userId).devices.remove(token);
    },
  };
}

/** FCM when a service-account key is configured, otherwise the no-op hook. */
export function createPushNotifier(cfg: Pick<AppConfig, 'FCM_SERVICE_ACCOUNT_JSON' | 'FCM_SERVICE_ACCOUNT_FILE'>, db: Db): { push: PushNotifier; enabled: boolean } {
  const json = cfg.FCM_SERVICE_ACCOUNT_JSON ?? (cfg.FCM_SERVICE_ACCOUNT_FILE ? readFileSync(cfg.FCM_SERVICE_ACCOUNT_FILE, 'utf8') : undefined);
  if (!json) return { push: noopPushNotifier, enabled: false };
  return { push: new FcmPushNotifier({ serviceAccount: parseServiceAccount(json), store: dbPushTokenStore(db) }), enabled: true };
}
