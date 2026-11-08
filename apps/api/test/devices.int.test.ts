import { MAX_DEVICES_PER_USER, scoped } from '@lawassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFullApp, type FullApp } from './helpers/full-app';

/** Push device registry (BE-26 push) against MySQL 8.4: register, refresh, sign-out, takeover, cap. */
let f: FullApp;
let a: { userId: string; token: string };
let b: { userId: string; token: string };

beforeAll(async () => {
  f = await startFullApp();
  a = await f.user('CITIZEN');
  b = await f.user('LAWYER');
}, 180_000);
afterAll(() => f?.stop());

const fcm = (n: string) => `fcm-${n}:APA91b${'x'.repeat(40)}`;
const call = (method: 'POST' | 'DELETE', who: { token: string } | null, payload: object) =>
  f.app.inject({ method, url: '/api/v1/me/devices', payload, headers: who ? { authorization: `Bearer ${who.token}` } : {} });
const tokensOf = async (userId: string) => (await scoped(f.db, userId).devices.list()).map((d) => d.token);

describe('POST/DELETE /me/devices', () => {
  it('registers idempotently and removes on sign-out', async () => {
    expect((await call('POST', a, { token: fcm('a1'), platform: 'ANDROID' })).statusCode).toBe(204);
    expect((await call('POST', a, { token: fcm('a1'), platform: 'ANDROID' })).statusCode).toBe(204);
    expect(await tokensOf(a.userId)).toEqual([fcm('a1')]);
    expect((await call('DELETE', a, { token: fcm('a1') })).statusCode).toBe(204);
    expect(await tokensOf(a.userId)).toEqual([]);
    expect((await call('DELETE', a, { token: fcm('never') })).statusCode).toBe(204);
  });

  it('needs a token, a valid FCM token and a known platform', async () => {
    expect((await call('POST', null, { token: fcm('x'), platform: 'IOS' })).statusCode).toBe(401);
    for (const body of [{ token: 'short', platform: 'IOS' }, { token: `${fcm('x')} space`, platform: 'IOS' }, { token: fcm('x'), platform: 'WINDOWS' }, { token: fcm('x'), platform: 'IOS', user_id: b.userId }]) {
      expect((await call('POST', a, body)).statusCode).toBe(422);
    }
  });

  it("can't remove another user's device; a device that signs in to another account moves to it", async () => {
    await call('POST', b, { token: fcm('shared'), platform: 'IOS' });
    await call('DELETE', a, { token: fcm('shared') });
    expect(await tokensOf(b.userId)).toEqual([fcm('shared')]);
    // Same phone, now signed in as A: B must stop getting this device's notifications.
    await call('POST', a, { token: fcm('shared'), platform: 'IOS' });
    expect(await tokensOf(b.userId)).toEqual([]);
    expect(await tokensOf(a.userId)).toEqual([fcm('shared')]);
  });

  it(`keeps the ${MAX_DEVICES_PER_USER} most recently seen devices`, async () => {
    for (let i = 0; i <= MAX_DEVICES_PER_USER + 1; i++) await call('POST', b, { token: fcm(`b${i}`), platform: 'ANDROID' });
    const kept = await tokensOf(b.userId);
    expect(kept).toHaveLength(MAX_DEVICES_PER_USER);
    expect(kept).not.toContain(fcm('b0'));
    expect(kept).toContain(fcm(`b${MAX_DEVICES_PER_USER + 1}`));
  });
});
