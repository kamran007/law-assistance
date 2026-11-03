import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { QdrantContainer, type StartedQdrantContainer } from '@testcontainers/qdrant';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, outboxEvents, runMigrations, sectionChunks, statutes, statuteSections, type Db } from '@lawassist/db';
import { QdrantChunkIndex, createQdrantClient, resolveAlias, type EmbeddingProvider, type QdrantClient } from '@lawassist/providers';
import { ensureChunkCollection, reindexAll } from '../src/index/collection';
import { SectionIndexer } from '../src/index/indexer';
import { INDEX_EVENT_TYPES, drainOutbox } from '../src/index/outbox';
import { parseActPrint } from '../src/scrape/parser';
import { DEFAULT_SOURCE_CONFIG as cfg } from '../src/scrape/source-config';
import { syncAct } from '../src/scrape/versioning';

/**
 * DATA-06 / DATA-07 against real MySQL 8.4 + Qdrant 1.15 (Testcontainers; needs Docker).
 * "Done when": outbox replay is idempotent. Embeddings come from a deterministic fake (the TEI
 * model image is too heavy for CI); the TEI client itself is unit-tested.
 */
const DIM = 1024;
const ALIAS = 'section_chunks';

class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake-bge-m3@test';
  readonly dimensions = DIM;
  calls = 0;
  texts = 0;
  failNext = false;
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('TEI unavailable');
    }
    this.calls++;
    this.texts += texts.length;
    return texts.map((t) => vectorFor(t));
  }
}

/** Deterministic unit vector per text. */
function vectorFor(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < DIM; i++) {
    for (const b of createHash('sha256').update(`${i}:${text}`).digest()) out.push(b / 255 - 0.5);
  }
  const v = out.slice(0, DIM);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const html = readFileSync(new URL('./fixtures/act-print-en.html', import.meta.url), 'utf8');
const parse = (h: string) => parseActPrint(h, { bdlawsActId: 11, sourceUrl: 'http://x/act-print-11.html' }, cfg);
const amended = html
  .replace('which may extend to seven years', 'which may extend to <sup>3</sup>[ten years]')
  .replace('</ol>', '<li><sup>3</sup> Substituted by the Penal Code (Amendment) Act, 2025 (Act No. 3 of 2025), with effect from 1st March, 2025</li></ol>');

let mysql: StartedMySqlContainer;
let qdrantC: StartedQdrantContainer;
let db: Db;
let close: () => Promise<void>;
let qdrant: QdrantClient;
const embedder = new FakeEmbedder();
let indexer: SectionIndexer;
let index: QdrantChunkIndex;

const pending = async () =>
  Number(
    (
      await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(outboxEvents)
        .where(and(isNull(outboxEvents.processedAt), sql`${outboxEvents.eventType} IN (${sql.join(INDEX_EVENT_TYPES.map((t) => sql`${t}`), sql`, `)})`))
    )[0]!.n,
  );
const chunkRows = () => db.select().from(sectionChunks).orderBy(asc(sectionChunks.chunkId));
const sectionVersions = (key: string) =>
  db.select().from(statuteSections).where(eq(statuteSections.normalizedSectionKey, key)).orderBy(asc(statuteSections.versionNumber));
const sectionIdsOf = (hits: { payload: { section_id: string } }[]) => [...new Set(hits.map((h) => h.payload.section_id))];

beforeAll(async () => {
  [mysql, qdrantC] = await Promise.all([
    new MySqlContainer('mysql:8.4')
      .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci'])
      .withRootPassword('root')
      .withDatabase('lawassist')
      .start(),
    new QdrantContainer('qdrant/qdrant:v1.15.4').start(),
  ]);
  const url = `mysql://root:root@${mysql.getHost()}:${mysql.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));
  qdrant = createQdrantClient({ url: `http://${qdrantC.getRestHostAddress()}` });
  await ensureChunkCollection(qdrant, ALIAS, DIM, log);
  index = new QdrantChunkIndex(qdrant, ALIAS);
  indexer = new SectionIndexer({ db, embedder, index });
});

afterAll(async () => {
  await close?.();
  await Promise.all([mysql?.stop(), qdrantC?.stop()]);
});

describe('outbox → TEI → Qdrant (DATA-06)', () => {
  it('indexes every new section version and marks events processed only after Qdrant confirms', async () => {
    await syncAct(db, parse(html), { today: '2026-11-03', snapshotKey: null });
    expect(await pending()).toBe(5);

    const r = await drainOutbox({ db, indexer, log });
    expect(r).toEqual({ processed: 5, failed: 0 });
    expect(await pending()).toBe(0);

    const rows = await chunkRows();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.every((c) => c.indexedAt !== null && c.embeddingModel === 'fake-bge-m3@test')).toBe(true);
    expect(rows.every((c) => c.chunkText.startsWith('THE PENAL CODE, 1860 | s. '))).toBe(true);
    expect(await index.count()).toBe(rows.length);
    expect(embedder.calls).toBe(1); // one batched embedding call for the whole outbox batch
  });

  it('replay is idempotent: same points, same rows, no re-embedding', async () => {
    const before = { rows: await chunkRows(), points: await index.count(), texts: embedder.texts };
    await db.update(outboxEvents).set({ processedAt: null }); // replay everything
    expect(await drainOutbox({ db, indexer, log })).toEqual({ processed: 5, failed: 0 });

    const after = await chunkRows();
    expect(after.map((c) => [c.chunkId, c.chunkText])).toEqual(before.rows.map((c) => [c.chunkId, c.chunkText]));
    expect(await index.count()).toBe(before.points);
    expect(embedder.texts).toBe(before.texts);
  });

  it('amendment: closed v1 keeps its vectors with is_current=false; point-in-time filters pick the right version', async () => {
    await syncAct(db, parse(amended), { today: '2026-11-05', snapshotKey: null });
    expect(await drainOutbox({ db, indexer, log })).toEqual({ processed: 2, failed: 0 }); // CREATED v2 + CLOSED v1
    const [v1, v2] = await sectionVersions('420');

    const v1Points = await qdrant.scroll(ALIAS, { filter: { must: [{ key: 'section_id', match: { value: v1!.sectionId } }] }, with_payload: true });
    expect(v1Points.points.length).toBeGreaterThan(0);
    expect(v1Points.points.every((p) => p.payload!.is_current === false && p.payload!.valid_to === '2025-03-01T00:00:00Z')).toBe(true);

    const query = vectorFor('cheating dishonestly inducing delivery of property');
    const current = sectionIdsOf(await index.search(query, { temporal: { kind: 'current' } }, 50));
    expect(current).toContain(v2!.sectionId);
    expect(current).not.toContain(v1!.sectionId);

    const in2020 = sectionIdsOf(await index.search(query, { temporal: { kind: 'asOf', date: '2020-01-01' } }, 50));
    expect(in2020).toContain(v1!.sectionId);
    expect(in2020).not.toContain(v2!.sectionId);

    // Boundary: valid_to is exclusive, so the amendment date itself already belongs to v2.
    const onDay = sectionIdsOf(await index.search(query, { temporal: { kind: 'asOf', date: '2025-03-01' } }, 50));
    expect(onDay).toContain(v2!.sectionId);
    expect(onDay).not.toContain(v1!.sectionId);
  });

  it('repeal propagates act_status; current-law search excludes the Act unless asked', async () => {
    const repealed = { ...parse(amended), isRepealed: true, sections: [] };
    await syncAct(db, repealed, { today: '2026-11-06', snapshotKey: null });
    expect(await drainOutbox({ db, indexer, log })).toEqual({ processed: 1, failed: 0 });

    const query = vectorFor('anything');
    expect(await index.search(query, { temporal: { kind: 'current' } }, 50)).toEqual([]);
    expect((await index.search(query, { temporal: { kind: 'current' }, includeRepealed: true }, 50)).length).toBeGreaterThan(0);

    await db.update(statutes).set({ status: 'ACTIVE' }).where(eq(statutes.bdlawsActId, 11));
    await indexer.refreshStatutePayload((await db.select().from(statutes))[0]!.statuteId);
  });

  it('a failing embed leaves the event pending with attempts + error, then succeeds on the next run', async () => {
    await syncAct(db, parse(amended.replace('one month', 'three months')), { today: '2026-11-07', snapshotKey: null });
    embedder.failNext = true;
    const first = await drainOutbox({ db, indexer, log });
    // Batch fails → per-section retry → that succeeds (failNext is one-shot).
    expect(first.failed).toBe(0);

    await syncAct(db, parse(amended.replace('one month', 'six months')), { today: '2026-11-08', snapshotKey: null });
    const created = await db.select().from(outboxEvents).where(isNull(outboxEvents.processedAt));
    expect(created.length).toBeGreaterThan(0);
    const broken: EmbeddingProvider = { model: embedder.model, dimensions: DIM, embed: async () => Promise.reject(new Error('TEI unavailable')) };
    const failing = await drainOutbox({ db, indexer: new SectionIndexer({ db, embedder: broken, index }), log });
    expect(failing.processed).toBeLessThan(created.length);
    expect(failing.failed).toBeGreaterThan(0);
    const [ev] = await db
      .select()
      .from(outboxEvents)
      .where(and(isNull(outboxEvents.processedAt), eq(outboxEvents.eventType, 'SECTION_VERSION_CREATED')));
    expect(ev).toMatchObject({ attempts: 1, lastError: 'Error: TEI unavailable' });

    expect((await drainOutbox({ db, indexer, log })).failed).toBe(0);
    expect(await pending()).toBe(0);
  });
});

describe('collection lifecycle (DATA-07)', () => {
  it('ensureChunkCollection is idempotent and creates the payload indexes', async () => {
    const name = await ensureChunkCollection(qdrant, ALIAS, DIM, log);
    expect(await ensureChunkCollection(qdrant, ALIAS, DIM, log)).toBe(name);
    const info = await qdrant.getCollection(name);
    expect(info.config.params.vectors).toMatchObject({ size: DIM, distance: 'Cosine' });
    expect(info.config.hnsw_config).toMatchObject({ m: 16, ef_construct: 128 });
    expect(Object.keys(info.payload_schema).sort()).toEqual(['act_status', 'is_current', 'section_id', 'statute_id', 'valid_from', 'valid_to']);
  });

  it('reindex --all rebuilds from MySQL into a new collection and swaps the alias', async () => {
    const before = await resolveAlias(qdrant, ALIAS);
    const points = await index.count();
    await new Promise((r) => setTimeout(r, 1100)); // physical names are second-resolution
    const r = await reindexAll({ db, client: qdrant, embedder, alias: ALIAS, log });

    expect(r.previous).toBe(before);
    expect(await resolveAlias(qdrant, ALIAS)).toBe(r.collection);
    expect((await qdrant.collectionExists(before!)).exists).toBe(false);
    expect(await index.count()).toBe(points); // the alias-bound index sees the new collection
    const allVersions = Number((await db.select({ n: sql<number>`COUNT(*)` }).from(statuteSections))[0]!.n);
    expect(r.sections).toBe(allVersions);
  });
});
