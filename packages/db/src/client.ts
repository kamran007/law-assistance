import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema/index';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(databaseUrl: string, opts: { connectionLimit?: number } = {}) {
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: opts.connectionLimit ?? 20, // TRD §11.3
    timezone: 'Z', // all DATETIME values are UTC
    charset: 'utf8mb4_0900_ai_ci',
    supportBigNumbers: true,
    multipleStatements: false,
  });
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, pool, close: () => pool.end() };
}
