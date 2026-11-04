import { readFileSync } from 'node:fs';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, outboxEvents, runMigrations, scrapeEvents, scrapeRuns, statutes, statuteSections, type Db } from '@lawassist/db';
import { PoliteHttpClient, type FetchLike } from '../src/scrape/http-client';
import { parseActPrint } from '../src/scrape/parser';
import { IntervalLimiter } from '../src/scrape/rate-limiter';
import { runScrape, syncFromSnapshot, type ScrapeDeps } from '../src/scrape/run-scrape';
import { MemorySnapshotStore } from '../src/scrape/snapshot-store';
import { DEFAULT_SOURCE_CONFIG as cfg } from '../src/scrape/source-config';
import { syncAct } from '../src/scrape/versioning';

/**
 * DATA-05 "done when": amend → archive → new current, including concurrent workers (TRD §6.3),
 * plus the Sprint 1 demo flow through runScrape. Real MySQL 8.4 via Testcontainers (needs Docker).
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;

const html = readFileSync(new URL('./fixtures/act-print-en.html', import.meta.url), 'utf8');
const parse = (h: string, actId = 11) => parseActPrint(h, { bdlawsActId: actId, sourceUrl: `http://x/act-print-${actId}.html` }, cfg);

/** s.420 amended: new punishment + a dated substitution footnote. */
const amended = html
  .replace('which may extend to seven years', 'which may extend to <sup>3</sup>[ten years]')
  .replace('</ul>', "<li class='footnoteList'><h6 class='word-formet'> <sup class='en'>3</sup> </h6>Substituted by the Penal Code (Amendment) Act, 2025 (Act No. 3 of 2025), with effect from 1st March, 2025</li></ul>");

/** Fake fetch bodies are bytes, like a real response (the client decodes them by charset). */
const toArrayBuffer = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

const versionsOf = (statuteId: string, key: string) =>
  db
    .select()
    .from(statuteSections)
    .where(and(eq(statuteSections.statuteId, statuteId), eq(statuteSections.normalizedSectionKey, key)))
    .orderBy(asc(statuteSections.versionNumber));

const outboxFor = (sectionId: string) =>
  db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, sectionId)).orderBy(asc(outboxEvents.id));

const count = async (table: typeof statuteSections | typeof outboxEvents) => Number((await db.select({ n: sql<number>`COUNT(*)` }).from(table))[0]!.n);

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 10 }));
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

describe('syncAct (TRD §6.3)', () => {
  let statuteId: string;

  it('first ingest creates v1 for every section, dated from enactment or insertion', async () => {
    const r = await syncAct(db, parse(html), { today: '2026-11-03', snapshotKey: 'raw/bdlaws/11/a.html.gz' });
    expect(r).toMatchObject({ status: 'SYNCED', created: 5, versioned: 0, closed: 0 });
    if (r.status !== 'SYNCED') throw new Error('unreachable');
    statuteId = r.statuteId;

    const [s420] = await versionsOf(statuteId, '420');
    expect(s420).toMatchObject({ versionNumber: 1, isCurrent: true, validFrom: '1860-10-06', validTo: null, validFromSource: 'ENACTMENT_DATE' });
    const [s326a] = await versionsOf(statuteId, '326A');
    expect(s326a).toMatchObject({ validFrom: '1984-07-01', validFromSource: 'AMENDMENT_FOOTNOTE' });

    const [statute] = await db.select().from(statutes).where(eq(statutes.statuteId, statuteId));
    expect(statute).toMatchObject({ titleEn: 'THE PENAL CODE, 1860', status: 'ACTIVE', rawHtmlS3Key: 'raw/bdlaws/11/a.html.gz' });
    expect((await outboxFor(s420!.sectionId)).map((e) => e.eventType)).toEqual(['SECTION_VERSION_CREATED']);
  });

  it('re-run with the same content creates no versions and no outbox events', async () => {
    const sections = await count(statuteSections);
    const events = await count(outboxEvents);
    const r = await syncAct(db, parse(html), { today: '2026-11-04', snapshotKey: null });
    expect(r).toMatchObject({ status: 'SYNCED', created: 0, versioned: 0, closed: 0 });
    expect(await count(statuteSections)).toBe(sections);
    expect(await count(outboxEvents)).toBe(events);
  });

  it('amend → archive v1 (valid_to) → v2 current from the footnote date, with outbox events', async () => {
    const r = await syncAct(db, parse(amended), { today: '2026-11-05', snapshotKey: null });
    expect(r).toMatchObject({ status: 'SYNCED', created: 0, versioned: 1 });

    const [v1, v2] = await versionsOf(statuteId, '420');
    expect(v1).toMatchObject({ versionNumber: 1, isCurrent: false, validTo: '2025-03-01', currentKey: null });
    expect(v2).toMatchObject({ versionNumber: 2, isCurrent: true, validFrom: '2025-03-01', validTo: null, validFromSource: 'AMENDMENT_FOOTNOTE' });
    expect(v2!.contentBody).toContain('3[ten years]');
    expect(v2!.amendmentFootnotes).toEqual([expect.objectContaining({ action: 'SUBSTITUTED', byAct: 'Act No. 3 of 2025', date: '2025-03-01' })]);

    expect((await outboxFor(v1!.sectionId)).map((e) => e.eventType)).toEqual(['SECTION_VERSION_CREATED', 'SECTION_VERSION_CLOSED']);
    expect((await outboxFor(v2!.sectionId)).map((e) => e.eventType)).toEqual(['SECTION_VERSION_CREATED', 'NOTIFY_AFFECTED_CASES']);
  });

  it('concurrent workers syncing the same amendment produce exactly one new current version', async () => {
    const again = amended.replace('[ten years]', '[twelve years]');
    const results = await Promise.all(
      Array.from({ length: 4 }, () => syncAct(db, parse(again), { today: '2026-11-06', snapshotKey: null })),
    );
    expect(results.every((r) => r.status === 'SYNCED')).toBe(true);
    const versions = await versionsOf(statuteId, '420');
    expect(versions.map((v) => [v.versionNumber, v.isCurrent])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    const createdV3 = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, versions[2]!.sectionId), eq(outboxEvents.eventType, 'SECTION_VERSION_CREATED')));
    expect(createdV3).toHaveLength(1);
  });

  it('concurrent first ingest of a new Act: one statute, one v1 per section', async () => {
    const results = await Promise.all(
      Array.from({ length: 3 }, () => syncAct(db, parse(html, 99), { today: '2026-11-03', snapshotKey: null })),
    );
    const ids = new Set(results.map((r) => r.statuteId));
    expect(ids.size).toBe(1);
    const rows = await db.select().from(statuteSections).where(eq(statuteSections.statuteId, [...ids][0]!));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.versionNumber === 1 && r.isCurrent)).toBe(true);
  });

  it('safety valve: > 20% of sections changed → quarantined, nothing committed', async () => {
    const before = await count(statuteSections);
    const mass = html.replaceAll('shall be punished', 'shall be liable to punishment');
    const r = await syncAct(db, parse(mass), { today: '2026-11-07', snapshotKey: null });
    expect(r.status).toBe('QUARANTINED');
    expect(r.plan.changeRatio).toBeGreaterThan(0.2);
    expect(await count(statuteSections)).toBe(before);

    const forced = await syncAct(db, parse(mass), { today: '2026-11-07', snapshotKey: null, force: true });
    expect(forced.status).toBe('SYNCED');
  });

  it('sections removed from the portal are superseded, never deleted', async () => {
    const cfgAct = parse(html, 99);
    const oneRemoved = { ...cfgAct, sections: cfgAct.sections.filter((s) => s.normalizedSectionKey !== '342') };
    const r = await syncAct(db, oneRemoved, { today: '2026-11-08', snapshotKey: null });
    expect(r).toMatchObject({ status: 'SYNCED', closed: 1 });
    const [statute] = await db.select().from(statutes).where(eq(statutes.bdlawsActId, 99));
    const [s342] = await versionsOf(statute!.statuteId, '342');
    expect(s342).toMatchObject({ isCurrent: false, validTo: '2026-11-08' });
  });

  it('repealed Act with an empty page: status changes, sections stay', async () => {
    const repealed = { ...parse(html, 99), isRepealed: true, sections: [] };
    const r = await syncAct(db, repealed, { today: '2026-11-09', snapshotKey: null });
    expect(r).toMatchObject({ status: 'SYNCED', closed: 0 });
    const [statute] = await db.select().from(statutes).where(eq(statutes.bdlawsActId, 99));
    expect(statute!.status).toBe('REPEALED');
    const current = await db
      .select()
      .from(statuteSections)
      .where(and(eq(statuteSections.statuteId, statute!.statuteId), eq(statuteSections.isCurrent, true)));
    expect(current).toHaveLength(4);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, 'STATUTE_STATUS_CHANGED'));
    expect(events).toHaveLength(1);
  });
});

describe('Sprint 1 demo flow via runScrape', () => {
  it('scrape → re-run (no versions) → edited snapshot → v2 created, v1 archived', async () => {
    const pages: Record<string, string> = {
      [`${cfg.baseUrl}/robots.txt`]: 'User-agent: *\nAllow: /',
      [`${cfg.baseUrl}/act-print-500.html`]: html,
    };
    const fetch: FetchLike = async (url) => ({
      status: pages[url] ? 200 : 404,
      headers: new Headers(),
      arrayBuffer: async () => toArrayBuffer(pages[url] ?? ''),
    });
    const snapshots = new MemorySnapshotStore();
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const deps: ScrapeDeps = {
      db,
      http: new PoliteHttpClient({ config: cfg, fetch, limiter: new IntervalLimiter(1000, () => 0, async () => undefined) }),
      snapshots,
      config: cfg,
      log,
      today: () => '2026-11-10',
    };

    const first = await runScrape(deps, { kind: 'MANUAL', actIds: [500] });
    expect(first).toMatchObject({ status: 'SUCCEEDED', actsChecked: 1, sectionsChanged: 5 });
    const second = await runScrape(deps, { kind: 'MANUAL', actIds: [500] });
    expect(second).toMatchObject({ status: 'SUCCEEDED', sectionsChanged: 0 });

    // Edit the stored snapshot by hand and re-sync from it.
    const [key] = [...snapshots.objects.keys()].sort().slice(-1);
    const edited = (await snapshots.get(key!)).replace('one month', 'three months');
    const editedKey = await snapshots.put(500, new Date('2026-11-10T12:00:00Z'), edited);
    const out = await syncFromSnapshot(deps, 500, editedKey);
    expect(out).toMatchObject({ kind: 'synced', result: { status: 'SYNCED', versioned: 1 } });

    const [statute] = await db.select().from(statutes).where(eq(statutes.bdlawsActId, 500));
    const [v1, v2] = await versionsOf(statute!.statuteId, '341');
    expect(v1).toMatchObject({ isCurrent: false, validTo: '2026-11-10' });
    expect(v2).toMatchObject({ isCurrent: true, versionNumber: 2, validFromSource: 'DETECTED_ON_SYNC' });

    const [run] = await db.select().from(scrapeRuns).where(eq(scrapeRuns.runId, first.runId));
    expect(run).toMatchObject({ status: 'SUCCEEDED', actsChecked: 1, sectionsChanged: 5 });
    expect(run!.finishedAt).toBeInstanceOf(Date);
  });

  it('records per-act failures as scrape_events and keeps going', async () => {
    const fetch: FetchLike = async (url) => ({
      status: url.endsWith('robots.txt') ? 404 : url.includes('act-print-600') ? 200 : 404,
      headers: new Headers(),
      arrayBuffer: async () => toArrayBuffer(url.includes('act-print-600') ? html : ''),
    });
    const deps: ScrapeDeps = {
      db,
      http: new PoliteHttpClient({ config: cfg, fetch, limiter: new IntervalLimiter(1000, () => 0, async () => undefined) }),
      snapshots: new MemorySnapshotStore(),
      config: cfg,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      today: () => '2026-11-10',
    };
    const summary = await runScrape(deps, { kind: 'MANUAL', actIds: [601, 600] });
    expect(summary).toMatchObject({ status: 'SUCCEEDED', actsChecked: 1, failedActs: [601] });
    const events = await db.select().from(scrapeEvents).where(eq(scrapeEvents.runId, summary.runId));
    expect(events).toEqual([expect.objectContaining({ level: 'ERROR', bdlawsActId: 601 })]);
  });
});
