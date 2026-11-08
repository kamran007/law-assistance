import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveKeyPath } from '../src/push';

/** The FCM key path in `.env` is relative to the repo root, whatever the working directory. */
describe('resolveKeyPath', () => {
  const repo = resolve(__dirname, '../../..');

  it('resolves a relative path against the repo root, also when run from apps/worker', () => {
    expect(resolveKeyPath('secrets/key.json', join(repo, 'apps', 'worker'))).toBe(join(repo, 'secrets', 'key.json'));
    expect(resolveKeyPath('secrets/key.json', repo)).toBe(join(repo, 'secrets', 'key.json'));
  });

  it('keeps absolute paths (containers mount the key)', () => {
    const abs = resolve('/secrets/firebase.json');
    expect(isAbsolute(abs)).toBe(true);
    expect(resolveKeyPath(abs, join(repo, 'apps', 'worker'))).toBe(abs);
  });
});
