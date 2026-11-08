'use client';

import type { paths } from '@lawassist/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, unwrap } from './api';
import { caseKeys, isStatus } from './cases';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
export type Draft = Json<paths['/api/v1/cases/{id}/drafts/{art_id}']['get']['responses'][200]>;
export type DraftTemplate = Json<paths['/api/v1/draft-templates']['get']['responses'][200]>['items'][number];

export const DRAFT_TYPE = 'VOICE_DICTATION_DRAFT';
export const draftKey = (caseId: string, artId: string) => ['drafts', caseId, artId] as const;

export function useDraftTemplates(enabled = true) {
  return useQuery({ queryKey: ['draft-templates'], queryFn: async () => (await unwrap(api.GET('/api/v1/draft-templates'))).items, enabled, staleTime: Infinity });
}

export function useCreateDraft(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { template_key: string; language: 'BN' | 'EN' }) => unwrap(api.POST('/api/v1/cases/{id}/drafts', { params: { path: { id: caseId } }, body })),
    onSuccess: (d) => {
      qc.setQueryData(draftKey(caseId, d.artifact_id), d);
      void qc.invalidateQueries({ queryKey: caseKeys.artifacts(caseId), exact: true });
    },
  });
}

export function useDraft(caseId: string, artId: string) {
  return useQuery({
    queryKey: draftKey(caseId, artId),
    queryFn: () => unwrap(api.GET('/api/v1/cases/{id}/drafts/{art_id}', { params: { path: { id: caseId, art_id: artId } } })),
    retry: (count, err) => count < 1 && !isStatus(err, 404),
    // The editor owns the text once loaded; refetching would overwrite unsaved typing.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** One draft save. `preserved` is set when another device's newer text was kept as a revision. */
export async function saveDraft(caseId: string, artId: string, html: string, version: number): Promise<{ draft: Draft; preserved: string | null }> {
  const res = await api.PATCH('/api/v1/cases/{id}/drafts/{art_id}', {
    params: { path: { id: caseId, art_id: artId } },
    body: { html },
    headers: { 'if-match': `"${version}"`, 'x-device-id': deviceId() },
  });
  const response: Response = res.response;
  if (!res.data) throw (res as { error?: unknown }).error ?? new Error(`HTTP ${response.status}`);
  return { draft: res.data, preserved: response.headers.get('x-conflict-preserved') };
}

/** A stable per-browser label, so preserved revisions show which device wrote them. */
function deviceId(): string {
  try {
    let id = localStorage.getItem('la.deviceId');
    if (!id) {
      id = `web-${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem('la.deviceId', id);
    }
    return id;
  } catch {
    return 'web';
  }
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/**
 * Autosave (App Flow §10): saves a few seconds after typing stops, one save at a time, always the
 * latest text. Tracks the version for If-Match. A save that hit a conflict still wins on the
 * server, which keeps the other device's text as a revision; `conflict` tells the editor to say so.
 */
export function useAutosave(opts: {
  initialVersion: number;
  save: (html: string, version: number) => Promise<{ draft: { version: number }; preserved: string | null }>;
  delayMs?: number;
  retryMs?: number;
}) {
  const { save, delayMs = 2000, retryMs = 5000 } = opts;
  const [state, setState] = useState<SaveState>('saved');
  const [conflict, setConflict] = useState(false);
  const version = useRef(opts.initialVersion);
  const pending = useRef<string | null>(null);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);

  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    if (running.current || pending.current === null) return;
    running.current = true;
    setState('saving');
    // Loop: text typed while a save was running is saved right after it.
    while (pending.current !== null) {
      const html: string = pending.current;
      pending.current = null;
      try {
        const res = await save(html, version.current);
        version.current = res.draft.version;
        if (res.preserved) setConflict(true);
      } catch {
        running.current = false;
        // Keep the unsaved text (unless newer text arrived) and try again shortly.
        pending.current ??= html;
        setState('error');
        timer.current = setTimeout(() => void flushRef.current(), retryMs);
        return;
      }
    }
    running.current = false;
    setState('saved');
  }, [save, retryMs]);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const change = useCallback(
    (html: string) => {
      pending.current = html;
      setState((s) => (s === 'saving' ? s : 'dirty'));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delayMs);
    },
    [flush, delayMs],
  );

  // Save on tab hide / navigation away; warn if the text isn't saved yet when closing the tab.
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && void flush();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current !== null || running.current) e.preventDefault();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearTimeout(timer.current);
      void flush();
    };
  }, [flush]);

  return { state, conflict, dismissConflict: () => setConflict(false), change, flush };
}
