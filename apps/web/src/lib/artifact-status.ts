'use client';

import { artifactStatusEvents, type ArtifactStatusEvent } from '@lawassist/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createAuthFetch } from './api';
import { authStore } from './auth/store';
import { caseKeys, type Artifact } from './cases';
import { API_URL } from './env';

export const TERMINAL = new Set(['READY', 'FAILED']);
/** Polling interval when the live stream is unavailable. */
export const POLL_MS = 5000;

export interface StatusStreamDeps {
  fetch?: typeof fetch;
  pollMs?: number;
}

/**
 * Follows one document's processing status (App Flow §9.3) and writes it into the cached
 * artifacts list. Uses the SSE stream (`GET …/events`, read with fetch because EventSource can't
 * send the bearer token); if the stream fails it falls back to polling the list. Stops at READY /
 * FAILED and on unmount.
 */
export function useArtifactStatus(caseId: string, artifact: Pick<Artifact, 'artifact_id' | 'processing_status'>, deps: StatusStreamDeps = {}) {
  const qc = useQueryClient();
  const status = artifact.processing_status ?? 'UPLOADED';
  const done = TERMINAL.has(status);
  const id = artifact.artifact_id;

  useEffect(() => {
    if (done) return;
    const controller = new AbortController();
    const doFetch = deps.fetch ?? createAuthFetch();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const apply = (e: Pick<ArtifactStatusEvent, 'status' | 'error'>) => {
      qc.setQueryData<Artifact[]>(caseKeys.artifacts(caseId), (list) =>
        list?.map((a) => (a.artifact_id === id ? { ...a, processing_status: e.status, processing_error: e.error } : a)),
      );
      qc.setQueryData<{ processing_status: string | null; processing_error: string | null }>([...caseKeys.artifacts(caseId), id], (d) =>
        d ? { ...d, processing_status: e.status, processing_error: e.error } : d,
      );
      // Schedule II results are stored at ANALYZING (before the role analysis); the finished
      // document's details at READY / FAILED. The prefix also refreshes the single-document view.
      if (TERMINAL.has(e.status) || e.status === 'ANALYZING') void qc.invalidateQueries({ queryKey: caseKeys.artifacts(caseId) });
    };

    const poll = () => {
      pollTimer = setTimeout(async () => {
        if (controller.signal.aborted) return;
        await qc.refetchQueries({ queryKey: caseKeys.artifacts(caseId) });
        const now = qc.getQueryData<Artifact[]>(caseKeys.artifacts(caseId))?.find((a) => a.artifact_id === id);
        if (!now || !TERMINAL.has(now.processing_status ?? 'UPLOADED')) poll();
      }, deps.pollMs ?? POLL_MS);
    };

    void (async () => {
      let last: string | null = null;
      try {
        // A stream ends at READY / FAILED or after the server's time cap; reconnect in the latter case.
        while (!controller.signal.aborted && (last === null || !TERMINAL.has(last))) {
          const res = await doFetch(`${API_URL}/api/v1/cases/${caseId}/artifacts/${id}/events`, {
            headers: { accept: 'text/event-stream', ...(authStore.accessToken ? { authorization: `Bearer ${authStore.accessToken}` } : {}) },
            signal: controller.signal,
          });
          if (res.status === 204) return; // already finished: the next list read has the result
          if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);
          let got = false;
          for await (const e of artifactStatusEvents(res.body, controller.signal)) {
            got = true;
            last = e.status;
            apply(e);
          }
          if (!got) throw new Error('empty stream');
        }
      } catch {
        if (!controller.signal.aborted) poll();
      }
    })();

    return () => {
      controller.abort();
      clearTimeout(pollTimer);
    };
  }, [caseId, id, done, qc, deps.fetch, deps.pollMs]);
}
