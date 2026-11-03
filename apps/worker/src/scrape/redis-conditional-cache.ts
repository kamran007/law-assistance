import type { Redis } from 'ioredis';
import type { ConditionalCache, Validators } from './http-client';

const PREFIX = 'scrape:validators:';
/** Older validators are useless: the weekly full crawl ignores them anyway. */
const TTL_SECONDS = 30 * 24 * 3600;

/** ETag / Last-Modified per URL, shared by all worker processes (TRD §6.1 conditional GET). */
export class RedisConditionalCache implements ConditionalCache {
  constructor(private readonly redis: Redis) {}

  async get(url: string): Promise<Validators | undefined> {
    const raw = await this.redis.get(PREFIX + url);
    return raw ? (JSON.parse(raw) as Validators) : undefined;
  }

  async set(url: string, v: Validators): Promise<void> {
    await this.redis.set(PREFIX + url, JSON.stringify(v), 'EX', TTL_SECONDS);
  }
}
