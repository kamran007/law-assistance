import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRANTS_FILE, createDb, newId, runMigrations, scoped, users, type Db } from '@lawassist/db';
import type { ChunkIndex, ChunkPoint, EmbeddingProvider } from '@lawassist/providers';
import { SectionIndexer } from '../src/index/indexer';
import { drainOutbox } from '../src/index/outbox';
import { parseActPrint } from '../src/scrape/parser';
import { DEFAULT_SOURCE_CONFIG as cfg } from '../src/scrape/source-config';
import { syncAct } from '../src/scrape/versioning';

/**
 * BE-02: `packages/db/sql/grants.sql` against real MySQL 8.4 (TRD §4.3). Each DB user runs the
 * real code paths it owns (positive) and is refused everything outside its role (negative).
 * Passwords are random per run; grants.sql only has placeholders.
 */
const ER_TABLEACCESS_DENIED = 1142;
const ER_DBACCESS_DENIED = 1044;
const ROLES = ['app_migrate', 'app_api', 'app_worker', 'app_scraper'] as const;
type Role = (typeof ROLES)[number];

let container: StartedMySqlContainer;
let root: Db;
const conns = {} as Record<Role, { db: Db; close: () => Promise<void> }>;
const passwords = Object.fromEntries(ROLES.map((r) => [r, randomBytes(18).toString('base64url')])) as Record<Role, string>;

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const html = readFileSync(new URL('./fixtures/act-print-en.html', import.meta.url), 'utf8');

/** In-memory ChunkIndex: this test is about MySQL privileges, not Qdrant. */
class MemoryChunkIndex implements ChunkIndex {
  points = new Map<string, ChunkPoint>();
  async upsert(points: readonly ChunkPoint[]) {
    for (const p of points) this.points.set(p.id, p);
  }
  async updateSection() {}
  async updateStatute() {}
  async deleteSectionChunksExcept() {}
  async search() {
    return [];
  }
  async count() {
    return this.points.size;
  }
}
const embedder: EmbeddingProvider = { model: 'fake', dimensions: 4, embed: async (t) => t.map(() => [1, 0, 0, 0]) };

/** Splits grants.sql into statements: drops `--` comments, fills password placeholders per user. */
export function grantStatements(file: string, pw: Record<string, string>): string[] {
  return file
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const user = /CREATE USER IF NOT EXISTS '(\w+)'/.exec(s)?.[1];
      return user ? s.replace('__SET_FROM_SECRET__', pw[user]!) : s;
    });
}

async function expectDenied(op: Promise<unknown>, errno = ER_TABLEACCESS_DENIED) {
  const err = await op.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the statement to be refused').not.toBeNull();
  let e: unknown = err;
  while (e && typeof (e as { errno?: unknown }).errno !== 'number') e = (e as { cause?: unknown }).cause;
  expect((e as { errno?: number } | undefined)?.errno).toBe(errno);
}

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const host = container.getHost();
  const port = container.getPort();
  const rootUrl = `mysql://root:root@${host}:${port}/lawassist`;
  await runMigrations(rootUrl);

  const admin = await mysql.createConnection({ uri: rootUrl, multipleStatements: false });
  // The placeholder check guards against a real password ever being committed to grants.sql.
  const file = readFileSync(GRANTS_FILE, 'utf8');
  expect(file.match(/IDENTIFIED BY '([^']*)'/g)?.every((m) => m.includes('__SET_FROM_SECRET__'))).toBe(true);
  for (const stmt of grantStatements(file, passwords)) await admin.query(stmt);
  await admin.end();

  ({ db: root } = createDb(rootUrl, { connectionLimit: 2 }));
  for (const r of ROLES) {
    conns[r] = createDb(`mysql://${r}:${encodeURIComponent(passwords[r])}@${host}:${port}/lawassist`, { connectionLimit: 2 });
  }
});

afterAll(async () => {
  for (const c of Object.values(conns)) await c.close();
  await container?.stop();
});

describe('app_scraper: statute data only (TRD §4.3)', () => {
  it('runs the versioning transaction (statutes, sections FOR UPDATE, outbox insert)', async () => {
    const act = parseActPrint(html, { bdlawsActId: 11, sourceUrl: 'http://x/act-print-11.html' }, cfg);
    const r = await syncAct(conns.app_scraper.db, act, { today: '2026-11-03', snapshotKey: null });
    expect(r).toMatchObject({ status: 'SYNCED', created: 5 });
  });

  it('cannot read or write user tables', async () => {
    const db = conns.app_scraper.db;
    await expectDenied(db.execute(sql`SELECT * FROM users`));
    await expectDenied(db.execute(sql`SELECT * FROM case_files`));
    await expectDenied(db.execute(sql`SELECT * FROM messages`));
  });

  it('cannot write Schedule II, mark outbox events processed, delete statute data or alter schema', async () => {
    const db = conns.app_scraper.db;
    await expectDenied(db.execute(sql`UPDATE crpc_schedule_metadata SET is_bailable = 1`));
    await expectDenied(db.execute(sql`UPDATE outbox_events SET processed_at = NOW(3)`));
    await expectDenied(db.execute(sql`DELETE FROM statute_sections`));
    await expectDenied(db.execute(sql`DROP TABLE scrape_events`));
  });
});

describe('app_worker: outbox, indexing and user-data jobs', () => {
  it('drains the outbox: reads sections, writes section_chunks, marks events processed', async () => {
    const indexer = new SectionIndexer({ db: conns.app_worker.db, embedder, index: new MemoryChunkIndex() });
    expect(await drainOutbox({ db: conns.app_worker.db, indexer, log })).toEqual({ processed: 5, failed: 0 });
  });

  it('cannot change statute data or Schedule II', async () => {
    const db = conns.app_worker.db;
    await expectDenied(db.execute(sql`UPDATE statute_sections SET is_current = 0`));
    await expectDenied(db.execute(sql`UPDATE statutes SET status = 'REPEALED'`));
    await expectDenied(db.execute(sql`UPDATE crpc_schedule_metadata SET is_bailable = 1`));
  });

  it('treats audit_log as append-only', async () => {
    const db = conns.app_worker.db;
    await db.execute(sql`INSERT INTO audit_log (action, entity) VALUES ('test', 'grants')`);
    await expectDenied(db.execute(sql`UPDATE audit_log SET action = 'tampered'`));
    await expectDenied(db.execute(sql`DELETE FROM audit_log`));
  });
});

describe('app_api: application DML, read-only law, no DDL', () => {
  it('runs scoped tenant operations (case + its conversation via the trigger-checked path)', async () => {
    const lawyerId = newId();
    await conns.app_api.db.insert(users).values({
      userId: lawyerId,
      fullName: 'Adv. Rahman',
      contactIdentifier: '+8801700000001',
      role: 'LAWYER',
      requestedRole: 'LAWYER',
      verificationStatus: 'VERIFIED',
    });
    const c = await scoped(conns.app_api.db, lawyerId).caseFiles.create({ title: 'State v. X' }, { withConversation: true });
    expect(c.caseFileId).toBeTruthy();
  });

  it('reads statute data but cannot change it', async () => {
    const db = conns.app_api.db;
    const [rows] = (await db.execute(sql`SELECT COUNT(*) AS n FROM statute_sections`)) as unknown as [{ n: number }[]];
    expect(Number(rows[0]!.n)).toBe(5);
    await expectDenied(db.execute(sql`UPDATE statute_sections SET content_body = 'x'`));
    await expectDenied(db.execute(sql`DELETE FROM statutes`));
  });

  it('can only insert outbox events and append to audit_log', async () => {
    const db = conns.app_api.db;
    await expectDenied(db.execute(sql`UPDATE outbox_events SET processed_at = NOW(3)`));
    await expectDenied(db.execute(sql`UPDATE audit_log SET action = 'tampered'`));
    await expectDenied(db.execute(sql`DELETE FROM audit_log`));
  });

  it('has no DDL', async () => {
    await expectDenied(conns.app_api.db.execute(sql`CREATE TABLE evil (id INT)`));
    await expectDenied(conns.app_api.db.execute(sql`ALTER TABLE users ADD COLUMN x INT`));
  });
});

describe('device_tokens (push): API registers, worker reads and prunes', () => {
  it('app_api registers, app_worker lists and deletes but cannot insert, app_scraper is refused', async () => {
    const userId = newId();
    await conns.app_api.db.insert(users).values({ userId, fullName: 'Push', contactIdentifier: '+8801700000077' });
    await scoped(conns.app_api.db, userId).devices.register('tok-A', 'ANDROID');
    await scoped(conns.app_api.db, userId).devices.register('tok-A', 'ANDROID'); // refresh, same row
    const worker = scoped(conns.app_worker.db, userId).devices;
    expect(await worker.list()).toEqual([{ token: 'tok-A', platform: 'ANDROID' }]);
    expect(await worker.remove('tok-A')).toBe(true);
    await expectDenied(worker.register('tok-B', 'IOS'));
    await expectDenied(conns.app_scraper.db.execute(sql`SELECT * FROM device_tokens`));
  });
});

describe('app_migrate: DDL only inside the app schema', () => {
  it('can create and drop tables in lawassist', async () => {
    await conns.app_migrate.db.execute(sql`CREATE TABLE grants_probe (id INT PRIMARY KEY)`);
    await conns.app_migrate.db.execute(sql`DROP TABLE grants_probe`);
  });

  it('has no access to other schemas', async () => {
    await expectDenied(conns.app_migrate.db.execute(sql`CREATE DATABASE other_schema`), ER_DBACCESS_DENIED);
    // Sanity: root still sees everything (the denials above are about grants, not a broken setup).
    await root.execute(sql`SELECT 1`);
  });
});
