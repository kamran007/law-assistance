import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

/**
 * A relative key path is relative to the repo root, where `.env` lives: `pnpm --filter` runs the
 * worker from `apps/worker`, so the working directory is the wrong base. Absolute paths (containers)
 * are used as given.
 */
export function resolveKeyPath(path: string, from = process.cwd()): string {
  if (isAbsolute(path)) return path;
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, path);
    if (dirname(dir) === dir) return resolve(from, path);
  }
}

/** FCM when a service-account key is configured, otherwise the no-op hook. */
export function createPushNotifier(cfg: Pick<AppConfig, 'FCM_SERVICE_ACCOUNT_JSON' | 'FCM_SERVICE_ACCOUNT_FILE'>, db: Db): { push: PushNotifier; enabled: boolean } {
  const json = cfg.FCM_SERVICE_ACCOUNT_JSON ?? (cfg.FCM_SERVICE_ACCOUNT_FILE ? readFileSync(resolveKeyPath(cfg.FCM_SERVICE_ACCOUNT_FILE), 'utf8') : undefined);
  if (!json) return { push: noopPushNotifier, enabled: false };
  return { push: new FcmPushNotifier({ serviceAccount: parseServiceAccount(json), store: dbPushTokenStore(db) }), enabled: true };
}
