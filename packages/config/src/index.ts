import { z } from 'zod';

/**
 * Environment schema (TRD §2, §7.6, §12.3).
 * The process refuses to boot if any value is invalid — see `loadConfig`.
 * Secrets (API keys, DB passwords, JWT keys) come from the environment only,
 * injected from AWS Secrets Manager in deployed environments.
 */
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3001'),

  DATABASE_URL: z.string().url().refine((u) => u.startsWith('mysql://'), 'DATABASE_URL must be a mysql:// URL'),
  /**
   * Worker only: the scraper's connection, as the `app_scraper` DB user (TRD §4.3). The outbox
   * and other worker jobs use DATABASE_URL (`app_worker`). Unset = DATABASE_URL (local dev only).
   */
  SCRAPER_DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().refine((u) => u.startsWith('mysql://'), 'SCRAPER_DATABASE_URL must be a mysql:// URL').optional(),
  ),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  TEI_EMBED_URL: z.string().url().default('http://localhost:8081'),
  /** Stored in section_chunks.embedding_model; changing it (e.g. a new revision) means a reindex. */
  EMBEDDING_MODEL: z.string().min(1).default('BAAI/bge-m3'),
  /** Qdrant ALIAS used for search; physical collections are <alias>_<timestamp> (TRD §4.4). */
  QDRANT_COLLECTION: z.string().regex(/^[a-z0-9_]+$/).default('section_chunks'),
  TEI_RERANK_URL: z.string().url().default('http://localhost:8082'),

  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default('lawassist-dev'),
  S3_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),

  /** Empty = call Anthropic directly; set = AI relay (TRD §7.6, decision D10). */
  ANTHROPIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  LLM_MODEL_ASSISTANT: z.string().default('claude-opus-5-5'),
  LLM_MODEL_EXTRACTION: z.string().default('claude-opus-5-5'),

  /** ES256 PEM keys (`\n`-escaped in env files). Development generates a throwaway pair if unset. */
  JWT_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  JWT_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** HMAC key for one-time codes (TRD §12.1); codes are stored only as HMACs. ≥ 32 characters. */
  OTP_HMAC_KEY: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  /**
   * How one-time codes are delivered. `console` prints them to the API's stdout and is for local
   * development only; it is refused in staging/production. A real SMS/email sender comes with
   * PRE-05 (SMS gateway contract, SES sender domain).
   */
  OTP_DELIVERY: z.enum(['console']).default('console'),
});

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Secrets that must be present outside local development and tests. */
const REQUIRED_IN_DEPLOYED_ENVS = ['ANTHROPIC_API_KEY', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'OTP_HMAC_KEY'] as const;

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Report variable names and messages only — never echo values (they may be secrets).
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'staging' || cfg.NODE_ENV === 'production') {
    const missing = REQUIRED_IN_DEPLOYED_ENVS.filter((k) => !cfg[k]);
    if (missing.length) throw new ConfigError(missing.map((k) => `${k}: required in ${cfg.NODE_ENV}`));
    if (cfg.OTP_DELIVERY === 'console') {
      throw new ConfigError([`OTP_DELIVERY: 'console' prints login codes and is not allowed in ${cfg.NODE_ENV}`]);
    }
  }
  return cfg;
}
