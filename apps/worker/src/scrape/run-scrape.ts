import { eq, sql } from 'drizzle-orm';
import { newId, scrapeEvents, scrapeRuns, statutes, type Db } from '@lawassist/db';
import { extractActIds } from './discover';
import { RobotsDisallowedError, type PoliteHttpClient } from './http-client';
import { parseActPrint } from './parser';
import type { SnapshotStore } from './snapshot-store';
import { actUrl, type SourceConfig } from './source-config';
import { syncAct, type SyncResult } from './versioning';

/** Minimal logger shape (pino-compatible). Never pass document text to it. */
export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ScrapeDeps {
  db: Db;
  http: PoliteHttpClient;
  snapshots: SnapshotStore;
  config: SourceConfig;
  log: Log;
  /** ISO date in Asia/Dhaka; injectable for tests. */
  today?: () => string;
}

export type ScrapeKind = 'NIGHTLY' | 'FULL' | 'MANUAL';

export interface ScrapeRequest {
  kind: ScrapeKind;
  /** Restrict the run to these acts (MANUAL runs, spike set). Default: discover from index pages. */
  actIds?: number[];
  /** Bypass the 20% safety valve (admin, after review). */
  force?: boolean;
}

export interface RunSummary {
  runId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'QUARANTINED';
  actsChecked: number;
  notModified: number;
  sectionsChanged: number;
  quarantinedActs: number[];
  failedActs: number[];
}

/** Abort the run when the portal looks down rather than logging 1,480 identical failures. */
const MAX_CONSECUTIVE_NETWORK_FAILURES = 5;

export const dhakaToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

export async function runScrape(deps: ScrapeDeps, req: ScrapeRequest): Promise<RunSummary> {
  const { db, log } = deps;
  const runId = newId();
  await db.insert(scrapeRuns).values({ runId, kind: req.kind });
  const event = (level: 'INFO' | 'WARN' | 'ERROR', message: string, bdlawsActId?: number) =>
    db.insert(scrapeEvents).values({ eventId: newId(), runId, level, message, bdlawsActId: bdlawsActId ?? null });

  const summary: RunSummary = {
    runId,
    status: 'SUCCEEDED',
    actsChecked: 0,
    notModified: 0,
    sectionsChanged: 0,
    quarantinedActs: [],
    failedActs: [],
  };

  try {
    const actIds = req.actIds?.length ? req.actIds : await discoverActIds(deps);
    if (!actIds.length) throw new Error('discovery found no acts; index page layout may have changed');
    log.info({ runId, kind: req.kind, acts: actIds.length }, 'scrape run started');

    let consecutiveNetworkFailures = 0;
    for (const actId of actIds) {
      try {
        const outcome = await scrapeOneAct(deps, actId, { conditional: req.kind !== 'FULL', force: req.force ?? false });
        consecutiveNetworkFailures = 0;
        summary.actsChecked++;
        if (outcome.kind === 'not-modified') {
          summary.notModified++;
          continue;
        }
        for (const w of outcome.warnings) await event('WARN', w, actId);
        if (outcome.result.status === 'QUARANTINED') {
          summary.quarantinedActs.push(actId);
          const pct = Math.round(outcome.result.plan.changeRatio * 100);
          await event('WARN', `quarantined: ${pct}% of sections changed (limit 20%); nothing committed`, actId);
          log.warn({ runId, actId, changeRatio: outcome.result.plan.changeRatio }, 'act quarantined');
        } else {
          summary.sectionsChanged += outcome.result.created + outcome.result.versioned + outcome.result.closed;
        }
      } catch (err) {
        summary.failedActs.push(actId);
        const message = err instanceof Error ? err.message : String(err);
        await event('ERROR', message.slice(0, 1000), actId);
        log.error({ runId, actId, err: message }, 'act failed');
        if (!(err instanceof RobotsDisallowedError) && isNetworkError(err)) {
          if (++consecutiveNetworkFailures >= MAX_CONSECUTIVE_NETWORK_FAILURES) {
            throw new Error(`aborting: ${consecutiveNetworkFailures} consecutive network failures`, { cause: err });
          }
        }
      }
    }
    summary.status = summary.quarantinedActs.length ? 'QUARANTINED' : 'SUCCEEDED';
  } catch (err) {
    summary.status = 'FAILED';
    const message = err instanceof Error ? err.message : String(err);
    await db.update(scrapeRuns).set({ error: message.slice(0, 2000) }).where(eq(scrapeRuns.runId, runId));
    log.error({ runId, err: message }, 'scrape run failed');
  }

  await db
    .update(scrapeRuns)
    .set({
      status: summary.status,
      actsChecked: summary.actsChecked,
      sectionsChanged: summary.sectionsChanged,
      finishedAt: new Date(),
    })
    .where(eq(scrapeRuns.runId, runId));
  log.info({ ...summary }, 'scrape run finished');
  return summary;
}

async function discoverActIds(deps: ScrapeDeps): Promise<number[]> {
  const ids = new Set<number>();
  for (const path of deps.config.urls.indexPaths) {
    const url = new URL(path, deps.config.baseUrl).toString();
    // Index pages are always fetched in full: a 304 would hide the act list.
    const res = await deps.http.get(url, { conditional: false });
    if (res.kind === 'ok') for (const id of extractActIds(res.body, deps.config)) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

type ActOutcome = { kind: 'not-modified' } | { kind: 'synced'; result: SyncResult; warnings: string[] };

export async function scrapeOneAct(
  deps: ScrapeDeps,
  actId: number,
  opts: { conditional: boolean; force: boolean },
): Promise<ActOutcome> {
  const url = actUrl(deps.config, 'actPrint', actId);
  const res = await deps.http.get(url, { conditional: opts.conditional });
  if (res.kind === 'not-modified') {
    await deps.db.update(statutes).set({ lastSyncedAt: sql`CURRENT_TIMESTAMP(3)` }).where(eq(statutes.bdlawsActId, actId));
    return { kind: 'not-modified' };
  }
  const key = await deps.snapshots.put(actId, res.fetchedAt, res.body);
  return syncFromHtml(deps, actId, res.body, key, opts.force);
}

/**
 * Re-parses a stored snapshot and syncs it. Parsing is reproducible from snapshots (TRD §6.1), so
 * this also serves the Sprint 1 demo (edit a snapshot by hand → re-run → v2 created).
 */
export async function syncFromSnapshot(deps: ScrapeDeps, actId: number, snapshotKey: string, force = false): Promise<ActOutcome> {
  const html = await deps.snapshots.get(snapshotKey);
  return syncFromHtml(deps, actId, html, snapshotKey, force);
}

async function syncFromHtml(deps: ScrapeDeps, actId: number, html: string, snapshotKey: string, force: boolean): Promise<ActOutcome> {
  const parsed = parseActPrint(html, { bdlawsActId: actId, sourceUrl: actUrl(deps.config, 'actPrint', actId) }, deps.config);
  if (!parsed.sections.length && !parsed.isRepealed) {
    // Likely a layout change or an error page. Never treat it as "every section removed".
    throw new Error(`no sections parsed (${parsed.warnings.length} warnings); snapshot ${snapshotKey}`);
  }
  const result = await syncAct(deps.db, parsed, { today: (deps.today ?? dhakaToday)(), snapshotKey, force });
  return { kind: 'synced', result, warnings: parsed.warnings };
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'HttpError') return (err as Error & { status: number }).status >= 500;
  return ['TimeoutError', 'AbortError', 'TypeError'].includes(err.name) || /ECONN|ETIMEDOUT|socket|fetch failed/i.test(err.message);
}
