import { loadConfig } from '@lawassist/config';
import { createDb } from '@lawassist/db';
import { sql } from 'drizzle-orm';
import { buildApp } from './app';

const config = loadConfig();
const { db, close } = createDb(config.DATABASE_URL);

const app = await buildApp(config, {
  checkReady: async () => {
    await db.execute(sql`SELECT 1`);
    return true;
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
