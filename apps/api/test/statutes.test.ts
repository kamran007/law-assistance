import { statuteGenerationKey } from '@lawassist/providers';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { requireProfessional, type Principal } from '../src/auth';
import { ApiError } from '../src/problem';
import { RedisSectionCache, resilient, type SectionCache } from '../src/modules/statutes/cache';
import { compareSectionKeys, groupByChapter } from '../src/modules/statutes/section-order';
import { dhakaToday } from '../src/time';

describe('section ordering', () => {
  it('sorts keys naturally: number, then letter suffix by length and alphabet', () => {
    const keys = ['171I', '10', '120B', '2', '120', '120A', '171', '265K', '265I', '1', '120AA', '561A'];
    expect([...keys].sort(compareSectionKeys)).toEqual(['1', '2', '10', '120', '120A', '120B', '120AA', '171', '171I', '265I', '265K', '561A']);
  });

  it('groups consecutive sections by chapter', () => {
    const rows = [
      { k: '1', chapterReference: 'Chapter I' },
      { k: '2', chapterReference: 'Chapter I' },
      { k: '3', chapterReference: null },
      { k: '4', chapterReference: 'Chapter II' },
    ];
    expect(groupByChapter(rows).map((g) => [g.chapter, g.sections.map((s) => s.k)])).toEqual([
      ['Chapter I', ['1', '2']],
      [null, ['3']],
      ['Chapter II', ['4']],
    ]);
  });
});

describe('requireProfessional', () => {
  const p = (role: Principal['role'], verificationStatus: Principal['verificationStatus']): Principal => ({ userId: 'u', role, verificationStatus });
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'OK';
    } catch (e) {
      return e instanceof ApiError ? `${e.status} ${e.code}` : 'other';
    }
  };

  it('allows verified lawyers and judges, and admins', () => {
    expect(code(() => requireProfessional(p('LAWYER', 'VERIFIED'), 'x'))).toBe('OK');
    expect(code(() => requireProfessional(p('JUDGE', 'VERIFIED'), 'x'))).toBe('OK');
    expect(code(() => requireProfessional(p('ADMIN', 'NOT_REQUIRED'), 'x'))).toBe('OK');
  });

  it('rejects anonymous (401), citizens (403) and unverified professionals (403)', () => {
    expect(code(() => requireProfessional(null, 'x'))).toBe('401 AUTH_REQUIRED');
    expect(code(() => requireProfessional(p('CITIZEN', 'NOT_REQUIRED'), 'x'))).toBe('403 ROLE_FORBIDDEN');
    expect(code(() => requireProfessional(p('LAWYER', 'PENDING'), 'x'))).toBe('403 VERIFICATION_REQUIRED');
  });
});

describe('RedisSectionCache', () => {
  /** Just the two commands the cache uses. */
  function fakeRedis() {
    const store = new Map<string, string>();
    const ttls = new Map<string, number>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, _ex: 'EX', ttl: number) => {
        store.set(k, v);
        ttls.set(k, ttl);
        return 'OK';
      },
    };
    return { redis: redis as unknown as Redis, store, ttls };
  }

  it('stores entries with a TTL and keeps current and as-of reads apart', async () => {
    const { redis, ttls } = fakeRedis();
    const cache = new RedisSectionCache(redis, 120);
    await cache.set(11, '420', null, 'current');
    await cache.set(11, '420', '2024-01-01', 'old');
    expect(await cache.get(11, '420', null)).toBe('current');
    expect(await cache.get(11, '420', '2024-01-01')).toBe('old');
    expect(await cache.get(11, '420', '2025-01-01')).toBeNull();
    expect([...ttls.values()]).toEqual([120, 120]);
  });

  it('stops serving an entry once the scraper bumps the Act generation', async () => {
    const { redis, store } = fakeRedis();
    const cache = new RedisSectionCache(redis);
    await cache.set(11, '420', null, 'v1 text');
    store.set(statuteGenerationKey(11), '1'); // what the worker's onActSynced does (INCR)
    expect(await cache.get(11, '420', null)).toBeNull();
    expect(await cache.get(75, '420', null)).toBeNull(); // other Acts are keyed separately anyway
  });

  it('never fails a lookup when Redis is down', async () => {
    const broken: SectionCache = {
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
      set: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const errors: unknown[] = [];
    const cache = resilient(broken, (e) => errors.push(e));
    expect(await cache.get(11, '420', null)).toBeNull();
    await cache.set(11, '420', null, 'x');
    expect(errors).toHaveLength(2);
  });
});

describe('dhakaToday', () => {
  it('uses Asia/Dhaka (UTC+6), not UTC', () => {
    expect(dhakaToday(new Date('2026-11-04T18:30:00Z'))).toBe('2026-11-05');
    expect(dhakaToday(new Date('2026-11-04T17:59:00Z'))).toBe('2026-11-04');
  });
});
