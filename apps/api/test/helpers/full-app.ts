import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { loadConfig } from '@lawassist/config';
import { createDb, newId, runMigrations, users, type Db, type UserRole } from '@lawassist/db';
import { buildApp, type App } from '../../src/app';
import { jwtAuthenticate } from '../../src/modules/auth/authenticate';
import { AuthService } from '../../src/modules/auth/service';
import { TokenService } from '../../src/modules/auth/tokens';
import { noCache } from '../../src/modules/statutes/cache';
import { StatutesRepository } from '../../src/modules/statutes/repository';

/** MySQL 8.4 + the full API (every module), for integration tests that need real auth. */
export interface FullApp {
  app: App;
  db: Db;
  tokens: TokenService;
  /** Inserts a user and returns a valid access token for them. */
  user(role: UserRole, verificationStatus?: 'NOT_REQUIRED' | 'PENDING' | 'VERIFIED' | 'REJECTED'): Promise<{ userId: string; token: string }>;
  stop(): Promise<void>;
}

export async function startFullApp(opts: { today?: string } = {}): Promise<FullApp> {
  const container: StartedMySqlContainer = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  const { db, close } = createDb(url, { connectionLimit: 5 });
  const tokens = await TokenService.ephemeral();
  const authenticate = jwtAuthenticate(tokens);
  const today = () => opts.today ?? '2026-11-04';
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: url }), {
    statutes: { repo: new StatutesRepository(db), cache: noCache, authenticate, today },
    auth: { service: new AuthService({ db, tokens, sender: { send: async () => undefined }, otpKey: 'k'.repeat(32) }), authenticate, secureCookies: true },
    cases: { db, authenticate, today },
    conversations: { db, authenticate },
  });
  await app.ready();

  let n = 0;
  return {
    app,
    db,
    tokens,
    async user(role, verificationStatus) {
      const userId = newId();
      const vs = verificationStatus ?? (role === 'LAWYER' || role === 'JUDGE' ? 'VERIFIED' : 'NOT_REQUIRED');
      await db.insert(users).values({ userId, fullName: `${role} ${++n}`, contactIdentifier: `user${n}-${userId}@example.com`, role, requestedRole: role, verificationStatus: vs });
      const token = await tokens.signAccess({ sub: userId, role, vs, sid: newId() });
      return { userId, token };
    },
    async stop() {
      await app.close();
      await close();
      await container.stop();
    },
  };
}
