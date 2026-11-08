import { scoped, type Db, type ScopedRepos } from '@lawassist/db';
import { noopArtifactEvents, noopPushNotifier, type ArtifactEventPublisher, type ArtifactStatus, type PushNotifier } from '@lawassist/providers';

/**
 * Status events for the scan and analysis jobs (TRD §8.1 step 4; BE-26). Wraps the owner's scoped
 * repo so every successful status change is published to the API's SSE relay, and the push hook
 * runs when processing ends. Both are best effort: a Redis or push failure is logged, never thrown,
 * because the stored status is the source of truth (clients can always re-read the artifact).
 */
export interface StatusEventDeps {
  events?: ArtifactEventPublisher;
  push?: PushNotifier;
  log: { warn(o: object, m?: string): void };
}

export function trackedRepo(db: Db, ownerUserId: string, deps: StatusEventDeps): ScopedRepos {
  const repo = scoped(db, ownerUserId);
  const events = deps.events ?? noopArtifactEvents;
  const push = deps.push ?? noopPushNotifier;
  const setProcessing: ScopedRepos['artifacts']['setProcessing'] = async (artifactId, patch) => {
    const ok = await repo.artifacts.setProcessing(artifactId, patch);
    const status = patch.processingStatus as ArtifactStatus | null | undefined;
    if (ok && status) {
      try {
        await events.publish({ artifact_id: artifactId, status, error: status === 'FAILED' ? (patch.processingError ?? null) : null, at: new Date().toISOString() });
      } catch (err) {
        deps.log.warn({ artifactId, status, err: err instanceof Error ? err.message : String(err) }, 'status event not published');
      }
      if (status === 'READY' || status === 'FAILED') {
        try {
          await push.documentFinished({ userId: ownerUserId, artifactId, status });
        } catch (err) {
          deps.log.warn({ artifactId, status, err: err instanceof Error ? err.message : String(err) }, 'push notification failed');
        }
      }
    }
    return ok;
  };
  return { ...repo, artifacts: { ...repo.artifacts, setProcessing } };
}
