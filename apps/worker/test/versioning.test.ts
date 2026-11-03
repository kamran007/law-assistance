import { describe, expect, it } from 'vitest';
import type { ParsedFootnote } from '@lawassist/legal-text';
import type { ParsedSection } from '../src/scrape/parser';
import { effectiveDate, firstVersionValidFrom, mysqlErrno, planActSync, withRetry, type CurrentSectionRow } from '../src/scrape/versioning';

const section = (key: string, contentHash = `c${key}`, footnotesHash = `f${key}`, footnotes: ParsedFootnote[] = []): ParsedSection => ({
  sectionNumber: key,
  normalizedSectionKey: key,
  chapterReference: null,
  marginalHeading: null,
  contentBody: '',
  parts: [],
  footnotes,
  contentHash,
  footnotesHash,
});
const row = (key: string, contentHash = `c${key}`, footnotesHash = `f${key}`): CurrentSectionRow => ({
  sectionId: `id-${key}`,
  normalizedSectionKey: key,
  contentHash,
  footnotesHash,
});
const fn = (action: ParsedFootnote['action'], date: string | null, text = `${action} ${date}`): ParsedFootnote => ({ action, byAct: null, date, text });

describe('planActSync', () => {
  const keys = Array.from({ length: 10 }, (_, i) => String(i + 1));

  it('first ingest: everything is created and the ratio is 0 (never quarantined)', () => {
    const plan = planActSync([], keys.map((k) => section(k)));
    expect(plan.create).toHaveLength(10);
    expect(plan.changeRatio).toBe(0);
  });

  it('re-run with identical content: nothing to do', () => {
    const plan = planActSync(keys.map((k) => row(k)), keys.map((k) => section(k)));
    expect(plan).toMatchObject({ create: [], change: [], remove: [], unchanged: 10, changeRatio: 0 });
  });

  it('classifies content change, footnote-only change, new and removed sections', () => {
    const parsed = [section('1', 'NEW'), section('2', 'c2', 'NEW'), section('3'), section('11')];
    const plan = planActSync(keys.map((k) => row(k)), parsed);
    expect(plan.change.map((s) => s.normalizedSectionKey)).toEqual(['1', '2']);
    expect(plan.create.map((s) => s.normalizedSectionKey)).toEqual(['11']);
    expect(plan.remove.map((r) => r.normalizedSectionKey)).toEqual(['4', '5', '6', '7', '8', '9', '10']);
    expect(plan.unchanged).toBe(1);
    expect(plan.changeRatio).toBeCloseTo(1.0);
  });

  it('computes the ratio the 20% safety valve uses', () => {
    const two = planActSync(keys.map((k) => row(k)), keys.map((k, i) => section(k, i < 2 ? 'X' : `c${k}`)));
    expect(two.changeRatio).toBeCloseTo(0.2); // exactly 20% is allowed (limit is "more than")
    const three = planActSync(keys.map((k) => row(k)), keys.map((k, i) => section(k, i < 3 ? 'X' : `c${k}`)));
    expect(three.changeRatio).toBeGreaterThan(0.2);
  });
});

describe('effective dates', () => {
  it('uses the latest dated footnote that is new in this version', () => {
    const old = [fn('INSERTED', '1984-07-01')];
    const next = [fn('INSERTED', '1984-07-01'), fn('SUBSTITUTED', '2004-01-01'), fn('SUBSTITUTED', '2003-05-05')];
    expect(effectiveDate(next, old, '2026-11-03')).toEqual({ date: '2004-01-01', source: 'AMENDMENT_FOOTNOTE' });
  });

  it('falls back to the sync date when no new footnote carries a date', () => {
    expect(effectiveDate([fn('SUBSTITUTED', null)], [], '2026-11-03')).toEqual({ date: '2026-11-03', source: 'DETECTED_ON_SYNC' });
    const same = [fn('INSERTED', '1984-07-01')];
    expect(effectiveDate(same, same, '2026-11-03').source).toBe('DETECTED_ON_SYNC');
  });

  it('v1 starts at enactment on first ingest, or at the insertion date for inserted sections', () => {
    const ctx = { enactedDate: '1860-10-06', firstIngest: true, today: '2026-11-03' };
    expect(firstVersionValidFrom(section('420'), ctx)).toEqual({ date: '1860-10-06', source: 'ENACTMENT_DATE' });
    expect(firstVersionValidFrom(section('326A', 'c', 'f', [fn('INSERTED', '1984-07-01')]), ctx)).toEqual({ date: '1984-07-01', source: 'AMENDMENT_FOOTNOTE' });
    expect(firstVersionValidFrom(section('500'), { ...ctx, enactedDate: null })).toEqual({ date: '2026-11-03', source: 'DETECTED_ON_SYNC' });
  });

  it('a section that appears in an already-synced Act does not get the enactment date', () => {
    const ctx = { enactedDate: '1860-10-06', firstIngest: false, today: '2026-11-03' };
    expect(firstVersionValidFrom(section('500'), ctx)).toEqual({ date: '2026-11-03', source: 'DETECTED_ON_SYNC' });
  });
});

describe('withRetry / mysqlErrno', () => {
  it('finds the driver errno through Drizzle error wrapping', () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('Duplicate entry'), { errno: 1062 }) });
    expect(mysqlErrno(wrapped)).toBe(1062);
    expect(mysqlErrno(new Error('x'))).toBeUndefined();
  });

  it('retries duplicate-key / deadlock errors and rethrows others immediately', async () => {
    let n = 0;
    const result = await withRetry(async () => {
      if (++n < 3) throw Object.assign(new Error('deadlock'), { errno: 1213 });
      return 'ok';
    });
    expect([result, n]).toEqual(['ok', 3]);

    let m = 0;
    await expect(
      withRetry(async () => {
        m++;
        throw Object.assign(new Error('syntax'), { errno: 1064 });
      }),
    ).rejects.toThrow('syntax');
    expect(m).toBe(1);
  });
});
