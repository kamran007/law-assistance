import { readFileSync } from 'node:fs';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { createDb, judgments, newId, runMigrations, scrapeEvents, scrapeRuns, type Db } from '@lawassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgmentJobId, listSnapshotKey, runScobCrawl, type ScobCrawlDeps, type ScobJudgmentJob } from '../src/scob/crawl';
import { SCOB_SOURCE_CONFIG } from '../src/scob/source-config';
import { PoliteHttpClient, type FetchLike } from '../src/scrape/http-client';
import { MemorySnapshotStore } from '../src/scrape/snapshot-store';

/**
 * JUD-03 crawl against MySQL 8.4 (Testcontainers) with the real HTTP client and parsers; the
 * network is a fake that serves the pages saved in the JUD-01 spike (no live requests).
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 3 }));
}, 180_000);
afterAll(async () => {
  await close?.();
  await container?.stop();
});

const fixture = (f: string) => new Uint8Array(readFileSync(new URL(`./fixtures/scob/${f}`, import.meta.url)));
const BASE = SCOB_SOURCE_CONFIG.baseUrl;
const PAGES: Record<string, string> = {
  [`${BASE}${SCOB_SOURCE_CONFIG.indexPath}`]: 'index.html',
  [`${BASE}?page=bulletin/bulletin_list.php&menu=00&div_id=1&issue=5`]: 'list_AD_5.html',
  [`${BASE}?page=bulletin/bulletin_list.php&menu=00&div_id=2&issue=5`]: 'list_HD_5.html',
  [`${BASE}?page=bulletin/bulletin_list.php&menu=00&div_id=2&issue=14`]: 'list_HD_14.html',
  [`${BASE}?page=bulletin/bulletin_list_AD_20.php&menu=00&div_id=1&issue=20`]: 'list_AD_20.html',
  [`${BASE}?page=bulletin/bulletin_list_HD_20.php&menu=00&div_id=2&issue=20`]: 'list_HD_20.html',
};

function harness(opts: { failIndex?: boolean } = {}) {
  const requested: string[] = [];
  const fetch: FetchLike = async (url) => {
    requested.push(url);
    const file = PAGES[url];
    const status = url.endsWith('/robots.txt') ? 404 : opts.failIndex && url.includes('bulletin.php') ? 500 : file ? 200 : 500;
    const body = file ? fixture(file) : new Uint8Array();
    return { status, headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=UTF-8' : null) }, arrayBuffer: async () => body.slice().buffer };
  };
  const jobs: ScobJudgmentJob[] = [];
  const snapshots = new MemorySnapshotStore();
  const deps: ScobCrawlDeps = {
    db,
    http: new PoliteHttpClient({ config: { ...SCOB_SOURCE_CONFIG, minIntervalMs: 0, maxRetries: 0 }, fetch, sleep: async () => undefined }),
    snapshots,
    queue: { enqueue: async (j) => void jobs.push(...j) },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  return { deps, jobs, snapshots, requested };
}

describe('runScobCrawl', () => {
  it('crawls the index and both templates, snapshots each list, queues every new judgment and records the run', async () => {
    const h = harness();
    const s = await runScobCrawl(h.deps, { kind: 'MANUAL', issues: [5, 20] });
    expect(s).toMatchObject({ status: 'SUCCEEDED', issues: 2, listsFetched: 4, listsFailed: 0, rows: 5 + 15 + 8 + 17, queued: 45 });
    expect(h.requested[0]).toBe('https://www.supremecourt.gov.bd/robots.txt');

    const job = h.jobs.find((j) => j.row.issue === 20 && j.row.division === 'AD' && j.row.serial === 1)!;
    expect(job).toMatchObject({ issueYear: 2025, force: false, row: { citation: '20 SCOB [2025] AD', pdfUrl: 'https://www.supremecourt.gov.bd/resources/bulletin/20/1.%2020%20SCOB%20AD-1.pdf' } });
    expect(job.listingSnapshotKey).toMatch(/^raw\/scob\/lists\/20\/AD\/.+\.html\.gz$/);
    expect(judgmentJobId(job.row)).toBe('scob-20-AD-1');
    expect(new Set(h.jobs.map((j) => judgmentJobId(j.row))).size).toBe(45);

    // Snapshots keep the decoded page, Windows-1252 quotes included.
    expect(h.snapshots.objects.size).toBe(4);
    const ad5Key = [...h.snapshots.objects.keys()].find((k) => k.startsWith('raw/scob/lists/5/AD/'))!;
    const ad5 = await h.snapshots.get(ad5Key);
    expect(ad5).not.toContain(String.fromCodePoint(0xfffd));
    expect([0x2018, 0x2019, 0x201c, 0x201d].some((c) => ad5.includes(String.fromCodePoint(c)))).toBe(true);

    const [run] = await db.select().from(scrapeRuns).where(eq(scrapeRuns.runId, s.runId));
    expect(run).toMatchObject({ source: 'SCOB', kind: 'MANUAL', status: 'SUCCEEDED', details: expect.objectContaining({ queued: 45 }) });
    expect(run!.finishedAt).not.toBeNull();
  });

  it('queues only judgments not stored yet; `all` queues everything again with force', async () => {
    for (let serial = 1; serial <= 5; serial++) {
      await db.insert(judgments).values({
        judgmentId: newId(),
        issueNumber: 5,
        issueYear: 2015,
        division: 'AD',
        serialNumber: serial,
        citation: `5 SCOB [2015] AD ${serial}`,
        parties: 'x',
        keyWords: '',
        keyRatioParagraphs: [],
        sourcePdfUrl: `https://example.test/${serial}.pdf`,
        normalizedSectionKeys: [],
      });
    }
    const again = harness();
    expect(await runScobCrawl(again.deps, { kind: 'WEEKLY', issues: [5] })).toMatchObject({ rows: 20, queued: 15 });
    expect(again.jobs.every((j) => j.row.division === 'HCD')).toBe(true);

    const all = harness();
    expect(await runScobCrawl(all.deps, { kind: 'BACKFILL', issues: [5], all: true })).toMatchObject({ queued: 20 });
    expect(all.jobs.every((j) => j.force)).toBe(true);
  });

  it('a failing list is logged and skipped; the run still succeeds with the other lists', async () => {
    const h = harness();
    const s = await runScobCrawl(h.deps, { kind: 'MANUAL', issues: [14] }); // the AD list of issue 14 answers 500 here
    expect(s).toMatchObject({ status: 'SUCCEEDED', listsFetched: 1, listsFailed: 1, queued: 16 });
    const events = await db.select().from(scrapeEvents).where(eq(scrapeEvents.runId, s.runId));
    expect(events.map((e) => [e.level, e.message])).toEqual([['ERROR', expect.stringMatching(/^Issue 14 AD: list failed/)]]);
    expect(listSnapshotKey(14, 'HCD', new Date('2026-11-08T10:00:00Z'))).toBe('raw/scob/lists/14/HCD/2026-11-08T10-00-00.000Z.html.gz');
  });

  it('an unreachable index fails the run without queueing anything', async () => {
    const h = harness({ failIndex: true });
    const s = await runScobCrawl(h.deps, { kind: 'WEEKLY' });
    expect(s).toMatchObject({ status: 'FAILED', queued: 0 });
    const [run] = await db.select().from(scrapeRuns).where(eq(scrapeRuns.runId, s.runId));
    expect(run).toMatchObject({ status: 'FAILED', error: expect.stringContaining('500') });
    expect(h.jobs).toEqual([]);
  });
});
