import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisArtifactEventHub, RedisArtifactEventPublisher, type ArtifactEvent } from '../src/artifact-events';

/** Document status pub/sub (BE-26) against a real Redis 7.4 (Testcontainers, needs Docker). */
let container: StartedTestContainer;
let pub: Redis;
let sub: Redis;
let hub: RedisArtifactEventHub;
let publisher: RedisArtifactEventPublisher;

beforeAll(async () => {
  container = await new GenericContainer('redis:7.4-alpine').withExposedPorts(6379).start();
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  pub = new Redis(url);
  sub = new Redis(url);
  hub = new RedisArtifactEventHub(sub);
  publisher = new RedisArtifactEventPublisher(pub);
}, 120_000);

afterAll(async () => {
  pub?.disconnect();
  sub?.disconnect();
  await container?.stop();
});

const ev = (artifact_id: string, status: ArtifactEvent['status']): ArtifactEvent => ({ artifact_id, status, error: null, at: new Date().toISOString() });
const settle = () => new Promise((r) => setTimeout(r, 100));

describe('RedisArtifactEventHub', () => {
  it('delivers events for the subscribed artifact only, to every listener on one connection', async () => {
    const a: string[] = [];
    const b: string[] = [];
    const other: string[] = [];
    const offA = await hub.subscribe('art-1', (e) => void a.push(e.status));
    const offB = await hub.subscribe('art-1', (e) => void b.push(e.status));
    const offO = await hub.subscribe('art-2', (e) => void other.push(e.status));
    await publisher.publish(ev('art-1', 'ANALYZING'));
    await publisher.publish(ev('art-1', 'READY'));
    await settle();
    expect(a).toEqual(['ANALYZING', 'READY']);
    expect(b).toEqual(['ANALYZING', 'READY']);
    expect(other).toEqual([]);
    await Promise.all([offA(), offB(), offO()]);
  });

  it('unsubscribes from Redis when the last listener leaves', async () => {
    const off1 = await hub.subscribe('art-3', () => undefined);
    const off2 = await hub.subscribe('art-3', () => undefined);
    expect(await pub.pubsub('NUMSUB', 'artifact-events:art-3')).toEqual(['artifact-events:art-3', 1]); // one Redis subscription, two listeners
    await off1();
    expect(await pub.pubsub('NUMSUB', 'artifact-events:art-3')).toEqual(['artifact-events:art-3', 1]);
    await off2();
    expect(await pub.pubsub('NUMSUB', 'artifact-events:art-3')).toEqual(['artifact-events:art-3', 0]);
  });

  it('ignores malformed messages on the channel', async () => {
    const got: string[] = [];
    const off = await hub.subscribe('art-4', (e) => void got.push(e.status));
    await pub.publish('artifact-events:art-4', 'not json');
    await pub.publish('artifact-events:art-4', JSON.stringify({ hello: 'world' }));
    await publisher.publish(ev('art-4', 'READY'));
    await settle();
    expect(got).toEqual(['READY']);
    await off();
  });
});
