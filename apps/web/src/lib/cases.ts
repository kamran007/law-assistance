'use client';

import type { paths } from '@lawassist/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './api';
import type { Me } from './auth/store';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
export type CaseFile = Json<paths['/api/v1/cases/{id}']['get']['responses'][200]>;
export type CaseInput = NonNullable<paths['/api/v1/cases']['post']['requestBody']>['content']['application/json'];
export type Artifact = Json<paths['/api/v1/cases/{id}/artifacts']['get']['responses'][200]>['items'][number];
export type CaseConversation = Json<paths['/api/v1/cases/{id}/conversation']['get']['responses'][200]>;

export const caseKeys = {
  all: ['cases'] as const,
  one: (id: string) => ['cases', id] as const,
  artifacts: (id: string) => ['cases', id, 'artifacts'] as const,
  conversation: (id: string) => ['cases', id, 'conversation'] as const,
};

/** Lawyers and Judges (verified, i.e. effective role) get Drafts and the case conversation (App Flow §8.2). */
export const isProfessional = (u: Pick<Me, 'role'>) => u.role === 'LAWYER' || u.role === 'JUDGE';

export function useCases() {
  return useQuery({
    queryKey: caseKeys.all,
    queryFn: async () => (await unwrap(api.GET('/api/v1/cases'))).items,
  });
}

export function useCase(id: string) {
  return useQuery({
    queryKey: caseKeys.one(id),
    queryFn: () => unwrap(api.GET('/api/v1/cases/{id}', { params: { path: { id } } })),
    retry: (count, err) => count < 1 && !isStatus(err, 404),
  });
}

export function useArtifacts(id: string, enabled = true) {
  return useQuery({
    queryKey: caseKeys.artifacts(id),
    queryFn: async () => (await unwrap(api.GET('/api/v1/cases/{id}/artifacts', { params: { path: { id } } }))).items,
    enabled,
  });
}

export function useCaseConversation(id: string, enabled: boolean) {
  return useQuery({
    queryKey: caseKeys.conversation(id),
    queryFn: () => unwrap(api.GET('/api/v1/cases/{id}/conversation', { params: { path: { id } } })),
    enabled,
  });
}

export function useCreateCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CaseInput) => unwrap(api.POST('/api/v1/cases', { body })),
    onSuccess: (created) => {
      qc.setQueryData(caseKeys.one(created.case_id), created);
      void qc.invalidateQueries({ queryKey: caseKeys.all, exact: true });
    },
  });
}

/** Optimistic concurrency: the edit carries the version it was based on (If-Match); 409 = changed elsewhere. */
export function useUpdateCase(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ version, body }: { version: number; body: CaseInput }) =>
      unwrap(api.PATCH('/api/v1/cases/{id}', { params: { path: { id } }, body, headers: { 'if-match': `"${version}"` } })),
    onSuccess: (updated) => {
      qc.setQueryData(caseKeys.one(id), updated);
      void qc.invalidateQueries({ queryKey: caseKeys.all, exact: true });
    },
    onError: (err) => {
      // Someone else changed it: show the current copy.
      if (isStatus(err, 409)) void qc.invalidateQueries({ queryKey: caseKeys.one(id) });
    },
  });
}

export function useDeleteCase(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error, response } = await api.DELETE('/api/v1/cases/{id}', { params: { path: { id } } });
      if (!response.ok) throw error ?? new Error(`HTTP ${response.status}`);
    },
    onSuccess: () => {
      qc.removeQueries({ queryKey: caseKeys.one(id) });
      void qc.invalidateQueries({ queryKey: caseKeys.all, exact: true });
    },
  });
}

export function isStatus(err: unknown, status: number): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === status;
}
