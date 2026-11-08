import type { Redis } from 'ioredis';

/**
 * Document processing status events (TRD §8.1 step 4; BE-26). The worker (and the API, for
 * `/reanalyze`) publishes on Redis pub/sub; the API's SSE endpoint relays them to the owner.
 * Payloads carry ids and status only: never document text or extracted content (TRD §12.3).
 */
export const ARTIFACT_EVENTS_PREFIX = 'artifact-events:';
export const artifactEventsChannel = (artifactId: string) => `${ARTIFACT_EVENTS_PREFIX}${artifactId}`;

export type ArtifactStatus = 'UPLOADED' | 'OCR' | 'EXTRACTING' | 'SCHEDULE_LOOKUP' | 'ANALYZING' | 'READY' | 'FAILED';
export const TERMINAL_STATUSES: readonly ArtifactStatus[] = ['READY', 'FAILED'];

export interface ArtifactEvent {
  artifact_id: string;
  status: ArtifactStatus;
  /** Failure code (e.g. PDF_ENCRYPTED) when status is FAILED, else null. */
  error: string | null;
  at: string;
}

export interface ArtifactEventPublisher {
  publish(event: ArtifactEvent): Promise<void>;
}

export const noopArtifactEvents: ArtifactEventPublisher = { publish: async () => undefined };

export class RedisArtifactEventPublisher implements ArtifactEventPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(event: ArtifactEvent): Promise<void> {
    await this.redis.publish(artifactEventsChannel(event.artifact_id), JSON.stringify(event));
  }
}

export type ArtifactEventListener = (event: ArtifactEvent) => void;

/** Fan-out of channel messages to in-process listeners (one subscriber connection per process). */
export interface ArtifactEventHub {
  /** Resolves once the subscription is active, so nothing published afterwards is missed. */
  subscribe(artifactId: string, listener: ArtifactEventListener): Promise<() => Promise<void>>;
}

const isEvent = (v: unknown): v is ArtifactEvent =>
  !!v && typeof v === 'object' && typeof (v as ArtifactEvent).artifact_id === 'string' && typeof (v as ArtifactEvent).status === 'string';

/**
 * Redis-backed hub. Uses a dedicated connection in subscriber mode (ioredis cannot run normal
 * commands on it). Channels are reference-counted: the first listener subscribes, the last one
 * leaving unsubscribes.
 */
export class RedisArtifactEventHub implements ArtifactEventHub {
  private readonly listeners = new Map<string, Set<ArtifactEventListener>>();

  constructor(private readonly subscriber: Redis) {
    subscriber.on('message', (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      let event: unknown;
      try {
        event = JSON.parse(message);
      } catch {
        return;
      }
      if (!isEvent(event)) return;
      for (const l of set) l(event);
    });
  }

  async subscribe(artifactId: string, listener: ArtifactEventListener): Promise<() => Promise<void>> {
    const channel = artifactEventsChannel(artifactId);
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(listener);
    return async () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    };
  }
}

/** In-process hub + publisher for tests and single-process development. */
export class MemoryArtifactEvents implements ArtifactEventHub, ArtifactEventPublisher {
  private readonly listeners = new Map<string, Set<ArtifactEventListener>>();
  readonly published: ArtifactEvent[] = [];

  async publish(event: ArtifactEvent): Promise<void> {
    this.published.push(event);
    for (const l of this.listeners.get(event.artifact_id) ?? []) l(event);
  }

  async subscribe(artifactId: string, listener: ArtifactEventListener): Promise<() => Promise<void>> {
    const set = this.listeners.get(artifactId) ?? new Set();
    set.add(listener);
    this.listeners.set(artifactId, set);
    return async () => void set.delete(listener);
  }

  subscriberCount(artifactId: string): number {
    return this.listeners.get(artifactId)?.size ?? 0;
  }
}

/**
 * Push notification hook (TRD §8.1 step 4): called when processing ends (READY / FAILED) so a
 * backgrounded mobile app can be told. The FCM implementation needs Firebase credentials and a
 * device-token registry, which arrive with the mobile app; until then the hook does nothing.
 */
export interface PushNotifier {
  documentFinished(n: { userId: string; artifactId: string; status: 'READY' | 'FAILED' }): Promise<void>;
}

export const noopPushNotifier: PushNotifier = { documentFinished: async () => undefined };
