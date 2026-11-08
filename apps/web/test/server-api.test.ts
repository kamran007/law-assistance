import { describe, expect, it } from 'vitest';
import { actTitle, dataOrNull } from '@/lib/server-api';

/** WEB-05 helpers for the server-rendered law library. */
const res = (status: number) => new Response(null, { status });

describe('dataOrNull', () => {
  it('returns data, null for missing or malformed ids (404 / 422), and throws otherwise', async () => {
    expect(await dataOrNull(Promise.resolve({ data: { a: 1 }, response: res(200) }))).toEqual({ a: 1 });
    expect(await dataOrNull(Promise.resolve({ error: { status: 404, code: 'SECTION_NOT_FOUND' }, response: res(404) }))).toBeNull();
    expect(await dataOrNull(Promise.resolve({ error: { status: 422, code: 'INVALID_SECTION' }, response: res(422) }))).toBeNull();
    await expect(dataOrNull(Promise.resolve({ error: { status: 503 }, response: res(503) }))).rejects.toThrow('API 503');
  });
});

describe('actTitle', () => {
  it('uses the title in the page language when there is one', () => {
    const act = { title: 'The Penal Code, 1860', title_en: 'The Penal Code, 1860', title_bn: 'দণ্ডবিধি, ১৮৬০' };
    expect(actTitle(act, 'bn')).toBe('দণ্ডবিধি, ১৮৬০');
    expect(actTitle(act, 'en')).toBe('The Penal Code, 1860');
    expect(actTitle({ ...act, title_bn: null }, 'bn')).toBe('The Penal Code, 1860');
  });
});
