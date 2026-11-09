import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { QdrantContainer, type StartedQdrantContainer } from '@testcontainers/qdrant';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, judgmentChunks, judgments, newId, outboxEvents, runMigrations, type Db } from '@lawassist/db';
import { QdrantJudgmentIndex, createQdrantClient, resolveAlias, type EmbeddingProvider, type QdrantClient } from '@lawassist/providers';
import { ensureJudgmentCollection, reindexJudgments } from '../src/index/collection';
import { JudgmentIndexer } from '../src/index/judgment-indexer';
import { drainOutbox } from '../src/index/outbox';
import { SectionIndexer } from '../src/index/indexer';
import { cleanPages, markParagraphs } from '../src/scob/text';

/**
 * JUD-06 against real MySQL 8.4 + Qdrant 1.15 (Testcontainers). "Done when": outbox replay is
 * idempotent. Embeddings come from a deterministic fake (TEI is unit-tested on its own).
 */
const DIM = 64;
const ALIAS = 'judgment_chunks';

class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake-bge-m3@test';
  readonly dimensions = DIM;
  texts = 0;
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.texts += texts.length;
    return texts.map((t) => {
      const v = [...createHash('sha512').update(t).digest()].map((b) => b / 255 - 0.5);
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    });
  }
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const fullText = markParagraphs(cleanPages([readFileSync(new URL('./fixtures/scob/header_hd14_1.txt', import.meta.url), 'utf8')])).text;
const BTRC = '0b0f3a3e-1111-4c4c-8a8a-000000000001';

let mysql: StartedMySqlContainer;
let qdrantC: StartedQdrantContainer;
let db: Db;
let close: () => Promise<void>;
let qdrant: QdrantClient;
let index: QdrantJudgmentIndex;
let indexer: JudgmentIndexer;
const embedder = new FakeEmbedder();
const outbox = () => ({ db, indexer: new SectionIndexer({ db, embedder, index: null as never }), judgments: indexer, log });

async function addJudgment(serial: number, over: Partial<typeof judgments.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await db.insert(judgments).values({
    judgmentId: id,
    issueNumber: 14,
    issueYear: 2020,
    division: 'HCD',
    serialNumber: serial,
    citation: '14 SCOB [2020] HCD',
    parties: 'Grameenphone Limited Vs. BTRC & ors',
    keyWords: 'The Bangladesh Telecommunication Regulation Act Section 63 and 65;',
    keyRatioParagraphs: ['20'],
    language: 'EN',
    fullText,
    sourcePdfUrl: 'https://www.supremecourt.gov.bd/resources/bulletin/14_SCOB_HD_1.pdf',
    normalizedSectionKeys: [`${BTRC}:63`],
    decisionDate: '2019-08-25',
    extractionStatus: 'OK',
    ...over,
  });
  return id;
}
const event = (aggregateId: string, eventType = 'JUDGMENT_UPSERTED') => db.insert(outboxEvents).values({ aggregate: 'judgment', aggregateId, eventType, payload: {} });
const pendingJudgmentEvents = async () => (await db.select().from(outboxEvents).where(and(isNull(outboxEvents.processedAt), eq(outboxEvents.aggregate, 'judgment')))).length;
const chunksOf = (id: string) => db.select().from(judgmentChunks).where(eq(judgmentChunks.judgmentId, id)).orderBy(asc(judgmentChunks.chunkIndex));

beforeAll(async () => {
  [mysql, qdrantC] = await Promise.all([
    new MySqlContainer('mysql:8.4')
      .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
      .withRootPassword('root')
      .withDatabase('lawassist')
      .start(),
    new QdrantContainer('qdrant/qdrant:v1.15.4').start(),
  ]);
  const url = `mysql://root:root@${mysql.getHost()}:${mysql.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));
  qdrant = createQdrantClient({ url: `http://${qdrantC.getRestHostAddress()}` });
  await ensureJudgmentCollection(qdrant, ALIAS, DIM, log);
  index = new QdrantJudgmentIndex(qdrant, ALIAS);
  indexer = new JudgmentIndexer({ db, embedder, index });
}, 240_000);

afterAll(async () => {
  await close?.();
  await Promise.all([mysql?.stop(), qdrantC?.stop()]);
});

describe('JUDGMENT_UPSERTED → judgment_chunks → Qdrant (JUD-06)', () => {
  let j1: string;

  it('indexes a judgment: chunk rows with paragraph ranges, one point per chunk with the TRD payload', async () => {
    j1 = await addJudgment(1);
    await event(j1);
    expect(await drainOutbox(outbox())).toEqual({ processed: 1, failed: 0 });
    expect(await pendingJudgmentEvents()).toBe(0);

    const rows = await chunksOf(j1);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((r) => r.indexedAt !== null && r.embeddingModel === 'fake-bge-m3@test')).toBe(true);
    expect(rows.at(-1)!.paragraphTo).toBe(23);
    expect(await index.count({ judgmentId: j1 })).toBe(rows.length);

    const [hit] = await index.search((await embedder.embed([rows[2]!.chunkText]))[0]!, {}, 1);
    expect(hit!.id).toBe(rows[2]!.chunkId);
    expect(hit!.payload).toEqual({
      judgment_id: j1,
      division: 'HCD',
      issue_year: 2020,
      decision_date: '2019-08-25T00:00:00Z',
      section_keys: [`${BTRC}:63`],
      statute_ids: [BTRC],
      lang: 'en',
      paragraph_from: rows[2]!.paragraphFrom,
      paragraph_to: rows[2]!.paragraphTo,
    });
  });

  it('replaying the event changes nothing and embeds nothing (idempotent)', async () => {
    const before = { rows: await chunksOf(j1), texts: embedder.texts };
    await event(j1);
    await event(j1);
    expect(await drainOutbox(outbox())).toEqual({ processed: 2, failed: 0 });
    expect(embedder.texts).toBe(before.texts);
    expect((await chunksOf(j1)).map((r) => r.chunkId)).toEqual(before.rows.map((r) => r.chunkId));
    expect(await index.count({ judgmentId: j1 })).toBe(before.rows.length);
  });

  it('new statute links (relink) only refresh the payload; the filters see them', async () => {
    const texts = embedder.texts;
    await db.update(judgments).set({ normalizedSectionKeys: [`${BTRC}:63`, `${BTRC}:65`] }).where(eq(judgments.judgmentId, j1));
    await event(j1);
    await drainOutbox(outbox());
    expect(embedder.texts).toBe(texts);
    const probe = (await embedder.embed(['probe']))[0]!;
    expect((await index.search(probe, { sectionKeys: [`${BTRC}:65`] }, 50)).length).toBe((await chunksOf(j1)).length);
    expect(await index.search(probe, { sectionKeys: ['other:1'] }, 5)).toEqual([]);
    expect((await index.search(probe, { division: 'AD' }, 5)).length).toBe(0);
  });

  it('a judgment without usable text is not indexed, and loses its chunks when it drops to NEEDS_REVIEW', async () => {
    const scanned = await addJudgment(2, { fullText: null, extractionStatus: 'NEEDS_REVIEW' });
    await event(scanned);
    await drainOutbox(outbox());
    expect(await chunksOf(scanned)).toEqual([]);
    expect(await index.count({ judgmentId: scanned })).toBe(0);

    const j3 = await addJudgment(3);
    await event(j3);
    await drainOutbox(outbox());
    expect(await index.count({ judgmentId: j3 })).toBeGreaterThan(0);
    await db.update(judgments).set({ extractionStatus: 'NEEDS_REVIEW' }).where(eq(judgments.judgmentId, j3));
    await event(j3);
    await drainOutbox(outbox());
    expect(await index.count({ judgmentId: j3 })).toBe(0);
    expect(await chunksOf(j3)).toEqual([]);
  });

  it('an unreachable embedding server skips the run without using up any event attempts', async () => {
    const j = await addJudgment(9);
    await event(j);
    expect(await drainOutbox({ ...outbox(), ready: async () => false })).toEqual({ processed: 0, failed: 0, skipped: true });
    const [row] = await db.select().from(outboxEvents).where(and(eq(outboxEvents.aggregateId, j), isNull(outboxEvents.processedAt)));
    expect(row).toMatchObject({ attempts: 0, lastError: null });
    expect(await drainOutbox({ ...outbox(), ready: async () => true })).toMatchObject({ processed: 1, failed: 0 });
    await db.delete(judgments).where(eq(judgments.judgmentId, j)); // keep the later counts unchanged
    await event(j, 'JUDGMENT_REMOVED');
    await drainOutbox(outbox());
  });

  it('JUDGMENT_REMOVED drops the chunks; without a judgment indexer the events are left for later', async () => {
    const j4 = await addJudgment(4);
    await event(j4);
    await drainOutbox(outbox());
    await event(j4, 'JUDGMENT_REMOVED');
    await drainOutbox(outbox());
    expect(await index.count({ judgmentId: j4 })).toBe(0);

    await event(j4);
    expect(await drainOutbox({ ...outbox(), judgments: undefined })).toEqual({ processed: 0, failed: 0 });
    expect(await pendingJudgmentEvents()).toBe(1);
    await drainOutbox(outbox());
  });

  it('reindexJudgments builds a new collection from MySQL and swaps the alias (backfill)', async () => {
    const before = await resolveAlias(qdrant, ALIAS);
    const r = await reindexJudgments({ db, client: qdrant, embedder, alias: ALIAS, log });
    expect(r.previous).toBe(before);
    expect(await resolveAlias(qdrant, ALIAS)).toBe(r.collection);
    expect(r.judgments).toBe(2); // j1 and j4 (re-added by the last upsert); the NEEDS_REVIEW ones are skipped
    expect(await index.count({ judgmentId: j1 })).toBe((await chunksOf(j1)).length);
    expect((await qdrant.collectionExists(before!)).exists).toBe(false);
  });
});
