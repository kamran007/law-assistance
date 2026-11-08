import { and, gte, inArray, isNotNull } from 'drizzle-orm';
import type { QdrantClient } from '@lawassist/providers';
import { outboxEvents, type Db } from '@lawassist/db';
import { QdrantChunkIndex, QdrantJudgmentIndex, createChunkCollection, createJudgmentCollection, resolveAlias, swapAlias, type EmbeddingProvider } from '@lawassist/providers';
import type { Log } from '../scrape/run-scrape';
import { SectionIndexer } from './indexer';
import { JudgmentIndexer } from './judgment-indexer';

/**
 * Collection lifecycle (DATA-07, TRD §4.4). Search always goes through an ALIAS (default
 * `section_chunks`) that points at a physical collection `section_chunks_<timestamp>`, so a full
 * rebuild can be swapped in without downtime.
 */
const physicalName = (alias: string, now = new Date()) => `${alias}_${now.toISOString().replace(/\D/g, '').slice(0, 14)}`;

/** Creates the first physical collection and alias if they don't exist. Idempotent. */
export async function ensureChunkCollection(
  client: QdrantClient,
  alias: string,
  dimensions: number,
  log: Log,
  create: (client: QdrantClient, name: string, dimensions: number) => Promise<void> = createChunkCollection,
): Promise<string> {
  const current = await resolveAlias(client, alias);
  if (current) {
    await create(client, current, dimensions); // re-asserts payload indexes
    return current;
  }
  if ((await client.collectionExists(alias)).exists) {
    throw new Error(`"${alias}" exists as a collection, not an alias; rename it before using alias-based reindexing`);
  }
  const name = physicalName(alias);
  await create(client, name, dimensions);
  await swapAlias(client, alias, name);
  log.info({ alias, collection: name }, 'chunk collection created');
  return name;
}

export interface ReindexResult {
  collection: string;
  previous: string | null;
  sections: number;
  caughtUp: number;
}

/**
 * `reindex --all`: builds a fresh collection from MySQL, swaps the alias, drops the old collection.
 * Sections changed while the rebuild ran (outbox events processed into the OLD collection) are
 * re-indexed into the new one before the swap.
 */
export async function reindexAll(
  deps: { db: Db; client: QdrantClient; embedder: EmbeddingProvider; alias: string; log: Log },
  opts: { pageSize?: number; keepPrevious?: boolean } = {},
): Promise<ReindexResult> {
  const startedAt = new Date();
  const collection = physicalName(deps.alias, startedAt);
  await createChunkCollection(deps.client, collection, deps.embedder.dimensions);
  const indexer = new SectionIndexer({ db: deps.db, embedder: deps.embedder, index: new QdrantChunkIndex(deps.client, collection) });

  let sections = 0;
  for await (const page of indexer.allSectionIds(opts.pageSize)) {
    sections += (await indexer.indexSections(page, { force: true })).embedded;
    deps.log.info({ collection, sections }, 'reindex progress');
  }

  const changed = await deps.db
    .selectDistinct({ id: outboxEvents.aggregateId, type: outboxEvents.eventType })
    .from(outboxEvents)
    .where(
      and(
        isNotNull(outboxEvents.processedAt),
        gte(outboxEvents.processedAt, startedAt),
        inArray(outboxEvents.eventType, ['SECTION_VERSION_CREATED', 'SECTION_VERSION_CLOSED']),
      ),
    );
  const caughtUpIds = [...new Set(changed.map((c) => c.id))];
  if (caughtUpIds.length) await indexer.indexSections(caughtUpIds, { force: true });

  const previous = await swapAlias(deps.client, deps.alias, collection);
  if (previous && previous !== collection && !opts.keepPrevious) await deps.client.deleteCollection(previous);
  deps.log.info({ alias: deps.alias, collection, previous, sections, caughtUp: caughtUpIds.length }, 'reindex complete');
  return { collection, previous, sections, caughtUp: caughtUpIds.length };
}

/** The judgment_chunks alias + collection (JUD-06, TRD §4.4: same alias pattern as statutes). */
export const ensureJudgmentCollection = (client: QdrantClient, alias: string, dimensions: number, log: Log) =>
  ensureChunkCollection(client, alias, dimensions, log, createJudgmentCollection);

/**
 * Rebuilds the judgment collection from MySQL and swaps the alias (also the backfill after the
 * first SCOB load). Judgments upserted while it ran are indexed again into the new collection.
 */
export async function reindexJudgments(
  deps: { db: Db; client: QdrantClient; embedder: EmbeddingProvider; alias: string; log: Log },
  opts: { pageSize?: number; keepPrevious?: boolean } = {},
): Promise<{ collection: string; previous: string | null; judgments: number; caughtUp: number }> {
  const startedAt = new Date();
  const collection = physicalName(deps.alias, startedAt);
  await createJudgmentCollection(deps.client, collection, deps.embedder.dimensions);
  const indexer = new JudgmentIndexer({ db: deps.db, embedder: deps.embedder, index: new QdrantJudgmentIndex(deps.client, collection) });

  let judgments = 0;
  for await (const page of indexer.allJudgmentIds(opts.pageSize)) {
    judgments += (await indexer.indexJudgments(page, { force: true })).embedded;
    deps.log.info({ collection, judgments }, 'judgment reindex progress');
  }
  const changed = await deps.db
    .selectDistinct({ id: outboxEvents.aggregateId })
    .from(outboxEvents)
    .where(and(isNotNull(outboxEvents.processedAt), gte(outboxEvents.processedAt, startedAt), inArray(outboxEvents.eventType, ['JUDGMENT_UPSERTED', 'JUDGMENT_REMOVED'])));
  const caughtUp = [...new Set(changed.map((c) => c.id))];
  if (caughtUp.length) await indexer.indexJudgments(caughtUp, { force: true });

  const previous = await swapAlias(deps.client, deps.alias, collection);
  if (previous && previous !== collection && !opts.keepPrevious) await deps.client.deleteCollection(previous);
  deps.log.info({ alias: deps.alias, collection, previous, judgments, caughtUp: caughtUp.length }, 'judgment reindex complete');
  return { collection, previous, judgments, caughtUp: caughtUp.length };
}
