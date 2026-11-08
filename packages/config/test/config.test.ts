import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index';

const base = { DATABASE_URL: 'mysql://u:p@localhost:3306/db' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.LLM_MODEL_ASSISTANT).toBe('claude-opus-5-5');
    expect(cfg.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...base, ANTHROPIC_BASE_URL: '' }).ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('rejects a non-mysql DATABASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y' })).toThrow(ConfigError);
  });

  it('requires secrets in production without echoing values', () => {
    try {
      loadConfig({ ...base, NODE_ENV: 'production', ANTHROPIC_BASE_URL: 'https://relay.example/v1' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues).toContain('ANTHROPIC_API_KEY: required in production');
    }
  });

  it('requires an OTP key and refuses console OTP delivery outside development', () => {
    const secrets = { ANTHROPIC_API_KEY: 'k', JWT_PRIVATE_KEY: 'p', JWT_PUBLIC_KEY: 'q', S3_SSE: 'aws:kms' };
    expect(() => loadConfig({ ...base, ...secrets, NODE_ENV: 'staging' })).toThrow(/OTP_HMAC_KEY: required in staging/);
    expect(() => loadConfig({ ...base, ...secrets, NODE_ENV: 'production', OTP_HMAC_KEY: 'x'.repeat(32) })).toThrow(/OTP_DELIVERY/);
    expect(() => loadConfig({ ...base, OTP_HMAC_KEY: 'too-short' })).toThrow(ConfigError);
    expect(loadConfig(base).OTP_DELIVERY).toBe('console');
  });

  it('OTP_DELIVERY=smtp needs SMTP_URL (smtp/smtps) and OTP_EMAIL_FROM, and is allowed in production', () => {
    expect(() => loadConfig({ ...base, OTP_DELIVERY: 'smtp' })).toThrow(/SMTP_URL: required when OTP_DELIVERY=smtp/);
    expect(() => loadConfig({ ...base, OTP_DELIVERY: 'smtp', SMTP_URL: 'https://mail.example', OTP_EMAIL_FROM: 'a@b.c' })).toThrow(/SMTP_URL/);
    const smtp = { OTP_DELIVERY: 'smtp', SMTP_URL: 'smtps://u:p@smtp.example.com:465', OTP_EMAIL_FROM: 'BD-LawAssist <no-reply@example.com>' };
    expect(loadConfig({ ...base, ...smtp }).OTP_DELIVERY).toBe('smtp');
    const secrets = { ANTHROPIC_API_KEY: 'k', JWT_PRIVATE_KEY: 'p', JWT_PUBLIC_KEY: 'q', S3_SSE: 'aws:kms', OTP_HMAC_KEY: 'x'.repeat(32) };
    expect(loadConfig({ ...base, ...secrets, ...smtp, NODE_ENV: 'production' }).OTP_DELIVERY).toBe('smtp');
  });

  it('never includes secret values in error messages', () => {
    const secret = 'sk-super-secret-value';
    try {
      loadConfig({ DATABASE_URL: 'not-a-url', ANTHROPIC_API_KEY: secret });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
