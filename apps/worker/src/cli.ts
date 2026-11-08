import { parseArgs } from 'node:util';
import { createWorkerContext } from './context';
import { ensureChunkCollection, reindexAll } from './index/collection';
import { drainOutbox } from './index/outbox';
import { runScrape, syncFromSnapshot } from './scrape/run-scrape';
import { runScobCrawl } from './scob/crawl';

/**
 * Manual runs (no queue):
 *   scrape -- --acts 11,75 [--full] [--force]          crawl specific Acts
 *   scrape -- --act 11 --snapshot raw/bdlaws/11/…gz     re-sync a stored snapshot
 *   scrape -- --setup-index                             create Qdrant collection + alias + payload indexes
 *   scrape -- --drain-outbox                            embed/index pending outbox events now
 *   scrape -- --reindex-all [--keep-previous]           rebuild the collection, swap the alias
 *   scrape -- --scob [--issues 19,20] [--all]           SCOB crawl: queue judgments not stored yet (all with --all)
 *   scrape -- --scob-backfill                           first full SCOB load (every issue)
 * SCOB runs fetch the live Supreme Court site: check PRE-11 (site terms) before a production run.
 */
const { values } = parseArgs({
  // pnpm may forward the "--" separator; drop it so options after it still parse.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    acts: { type: 'string' },
    act: { type: 'string' },
    snapshot: { type: 'string' },
    full: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'setup-index': { type: 'boolean', default: false },
    'drain-outbox': { type: 'boolean', default: false },
    'reindex-all': { type: 'boolean', default: false },
    'keep-previous': { type: 'boolean', default: false },
    scob: { type: 'boolean', default: false },
    'scob-backfill': { type: 'boolean', default: false },
    issues: { type: 'string' },
    all: { type: 'boolean', default: false },
  },
});

const ctx = createWorkerContext();
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
try {
  if (values['setup-index']) {
    print({ collection: await ensureChunkCollection(ctx.qdrant, ctx.cfg.QDRANT_COLLECTION, ctx.embedder.dimensions, ctx.log) });
  } else if (values['drain-outbox']) {
    print(await drainOutbox({ db: ctx.db, indexer: ctx.indexer, log: ctx.log }));
  } else if (values['reindex-all']) {
    print(
      await reindexAll(
        { db: ctx.db, client: ctx.qdrant, embedder: ctx.embedder, alias: ctx.cfg.QDRANT_COLLECTION, log: ctx.log },
        { keepPrevious: values['keep-previous'] },
      ),
    );
  } else if (values.scob || values['scob-backfill']) {
    const issues = values.issues?.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    const summary = await runScobCrawl(ctx.scob, { kind: values['scob-backfill'] ? 'BACKFILL' : 'MANUAL', ...(issues?.length ? { issues } : {}), all: values.all });
    print(summary);
    process.exitCode = summary.status === 'FAILED' ? 1 : 0;
  } else if (values.snapshot) {
    if (!values.act) throw new Error('--snapshot needs --act');
    const out = await syncFromSnapshot(ctx.scrape, Number(values.act), values.snapshot, values.force);
    print(out.kind === 'synced' ? out.result : out);
  } else {
    const actIds = values.acts?.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    const summary = await runScrape(ctx.scrape, {
      kind: values.full ? 'FULL' : 'MANUAL',
      ...(actIds?.length ? { actIds } : {}),
      force: values.force,
    });
    print(summary);
    process.exitCode = summary.status === 'FAILED' ? 1 : 0;
  }
} finally {
  await ctx.close();
}
