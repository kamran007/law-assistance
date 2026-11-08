import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FCM_SCOPE, FcmPushNotifier, FcmSendError, PUSH_TEXT, parseServiceAccount, type PushTokenStore } from '../src/fcm';

/** FCM HTTP v1 sender (BE-26 push) against a fake fetch: OAuth grant, message shape, dead tokens. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account',
  project_id: 'lawassist-test',
  client_email: 'push@lawassist-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.example.test/token',
};
const serviceAccount = parseServiceAccount(JSON.stringify(SA));

type Call = { url: string; init: RequestInit };
function fakeFetch(sendStatus: (token: string) => { status: number; body?: unknown } = () => ({ status: 200 })) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === SA.token_uri) return Response.json({ access_token: `at-${calls.length}`, expires_in: 3600 });
    const token = (JSON.parse(String(init.body)) as { message: { token: string } }).message.token;
    const r = sendStatus(token);
    return Response.json(r.body ?? { name: 'projects/x/messages/1' }, { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls, sends: () => calls.filter((c) => c.url !== SA.token_uri) };
}

function store(tokens: string[], language: 'BN' | 'EN' = 'BN') {
  const removed: string[] = [];
  const s: PushTokenStore = { forUser: async () => ({ language, tokens }), remove: async (_u, t) => void removed.push(t) };
  return { s, removed };
}

const finished = { userId: 'u1', artifactId: 'a1', status: 'READY' as const };

describe('parseServiceAccount', () => {
  it('accepts a service-account key and names bad fields without echoing values', () => {
    expect(serviceAccount.project_id).toBe('lawassist-test');
    expect(() => parseServiceAccount('{')).toThrow('not valid JSON');
    const bad = JSON.stringify({ ...SA, private_key: 'secret-value', client_email: 'nope' });
    expect(() => parseServiceAccount(bad)).toThrow(/client_email, private_key/);
    expect(() => parseServiceAccount(bad)).not.toThrow(/secret-value/);
  });
});

describe('FcmPushNotifier', () => {
  it('gets an OAuth token with a signed JWT and sends a content-free message to every device', async () => {
    const { f, calls, sends } = fakeFetch();
    const n = new FcmPushNotifier({ serviceAccount, store: store(['t1', 't2']).s, fetch: f });
    await n.documentFinished(finished);

    const grant = new URLSearchParams(String(calls[0]!.init.body));
    expect(grant.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, sig] = grant.get('assertion')!.split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({ iss: SA.client_email, scope: FCM_SCOPE, aud: SA.token_uri });

    expect(sends().map((s) => s.url)).toEqual(Array(2).fill('https://fcm.googleapis.com/v1/projects/lawassist-test/messages:send'));
    const msg = JSON.parse(String(sends()[0]!.init.body)).message;
    expect(msg).toMatchObject({ token: 't1', notification: PUSH_TEXT.BN.READY, data: { type: 'DOCUMENT_FINISHED', artifact_id: 'a1', status: 'READY' } });
    expect((sends()[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer at-1');
  });

  it('caches the access token across notifications and uses the user language', async () => {
    const { f, calls } = fakeFetch();
    const n = new FcmPushNotifier({ serviceAccount, store: store(['t1'], 'EN').s, fetch: f });
    await n.documentFinished(finished);
    await n.documentFinished({ ...finished, status: 'FAILED' });
    expect(calls.filter((c) => c.url === SA.token_uri)).toHaveLength(1);
    expect(JSON.parse(String(calls.at(-1)!.init.body)).message.notification).toEqual(PUSH_TEXT.EN.FAILED);
  });

  it('removes tokens FCM reports as unregistered and keeps the rest', async () => {
    const { f } = fakeFetch((t) =>
      t === 'dead' ? { status: 404, body: { error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } } : { status: 200 },
    );
    const st = store(['live', 'dead']);
    await new FcmPushNotifier({ serviceAccount, store: st.s, fetch: f }).documentFinished(finished);
    expect(st.removed).toEqual(['dead']);
  });

  it('throws when every device fails for a transient reason, without removing tokens', async () => {
    const { f } = fakeFetch(() => ({ status: 503, body: { error: { status: 'UNAVAILABLE' } } }));
    const st = store(['t1']);
    await expect(new FcmPushNotifier({ serviceAccount, store: st.s, fetch: f }).documentFinished(finished)).rejects.toBeInstanceOf(FcmSendError);
    expect(st.removed).toEqual([]);
  });

  it('does nothing for a user without devices', async () => {
    const { f, calls } = fakeFetch();
    await new FcmPushNotifier({ serviceAccount, store: store([]).s, fetch: f }).documentFinished(finished);
    expect(calls).toEqual([]);
  });
});
