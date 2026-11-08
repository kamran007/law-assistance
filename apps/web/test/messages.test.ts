import { describe, expect, it } from 'vitest';
import bn from '../messages/bn.json';
import en from '../messages/en.json';
import { routing } from '../src/i18n/routing';

/** WEB-01: both languages ship the same message keys and ICU placeholders. */
type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v]] : Object.entries(flatten(v, `${prefix}${k}.`)))));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

describe('messages', () => {
  const b = flatten(bn as Tree);
  const e = flatten(en as Tree);

  it('have the same keys in Bangla and English', () => {
    expect(Object.keys(b).sort()).toEqual(Object.keys(e).sort());
  });

  it('use the same placeholders in both languages', () => {
    for (const k of Object.keys(e)) expect(placeholders(b[k]!), k).toEqual(placeholders(e[k]!));
  });

  it('Bangla texts are Bangla (except language names)', () => {
    const bengali = /\p{Script=Bengali}/u;
    const untranslated = Object.entries(b).filter(([k, v]) => !k.startsWith('language.') && !bengali.test(v));
    expect(untranslated).toEqual([]);
  });

  it('Bangla is the default locale and every locale has a file', () => {
    expect(routing.defaultLocale).toBe('bn');
    expect([...routing.locales].sort()).toEqual(['bn', 'en']);
  });
});
