import { parseArgs } from 'node:util';
import { createWorkerContext } from './context';
import { runScrape, syncFromSnapshot } from './scrape/run-scrape';

/**
 * Manual scraper runs (no queue):
 *   pnpm --filter @lawassist/worker scrape -- --acts 11,75 [--full] [--force]
 *   pnpm --filter @lawassist/worker scrape -- --act 11 --snapshot raw/bdlaws/11/....html.gz
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
  },
});

const ctx = createWorkerContext();
try {
  if (values.snapshot) {
    if (!values.act) throw new Error('--snapshot needs --act');
    const out = await syncFromSnapshot(ctx.scrape, Number(values.act), values.snapshot, values.force);
    console.log(JSON.stringify(out.kind === 'synced' ? out.result : out, null, 2));
  } else {
    const actIds = values.acts?.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    const summary = await runScrape(ctx.scrape, {
      kind: values.full ? 'FULL' : 'MANUAL',
      ...(actIds?.length ? { actIds } : {}),
      force: values.force,
    });
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.status === 'FAILED' ? 1 : 0;
  }
} finally {
  await ctx.close();
}
