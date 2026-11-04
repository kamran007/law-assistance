import type { Redis } from 'ioredis';
import { STATUTE_CACHE_PREFIX, statuteGenerationKey } from '@lawassist/providers';

/**
 * Cache for section reads (TRD §11.3). Entries are keyed by the Act's generation, which the
 * scraper bumps after each committed sync of that Act, so a changed Act is never served from
 * cache. The TTL only bounds staleness if a bump is lost (worker crash between commit and INCR).
 */
export interface SectionCache {
  get(actId: number, key: string, asOf: string | null): Promise<string | null>;
  set(actId: number, key: string, asOf: string | null, value: string): Promise<void>;
}

export const noCache: SectionCache = {
  get: async () => null,
  set: async () => undefined,
};

export const SECTION_CACHE_TTL_SECONDS = 3600;

export class RedisSectionCache implements SectionCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = SECTION_CACHE_TTL_SECONDS,
  ) {}

  private async entryKey(actId: number, key: string, asOf: string | null): Promise<string> {
    const gen = (await this.redis.get(statuteGenerationKey(actId))) ?? '0';
    return `${STATUTE_CACHE_PREFIX}:section:${actId}:${gen}:${key}:${asOf ?? 'current'}`;
  }

  async get(actId: number, key: string, asOf: string | null): Promise<string | null> {
    return this.redis.get(await this.entryKey(actId, key, asOf));
  }

  async set(actId: number, key: string, asOf: string | null, value: string): Promise<void> {
    await this.redis.set(await this.entryKey(actId, key, asOf), value, 'EX', this.ttlSeconds);
  }
}

/** A cache failure must never fail a law lookup: fall back to the database. */
export function resilient(cache: SectionCache, onError: (err: unknown) => void): SectionCache {
  return {
    get: (a, k, d) => cache.get(a, k, d).catch((err: unknown) => (onError(err), null)),
    set: (a, k, d, v) => cache.set(a, k, d, v).catch((err: unknown) => onError(err)),
  };
}
