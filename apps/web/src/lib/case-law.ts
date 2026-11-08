'use client';

import type { paths } from '@lawassist/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from './api';
import { isStatus } from './cases';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
export type SectionJudgments = Json<paths['/api/v1/statutes/{act_id}/sections/{sec}/judgments']['get']['responses'][200]>;

/** Judgments that discuss a section (newest first), for the verifier and section pages. */
export function useSectionJudgments(actId: number, sec: string, limit = 5) {
  return useQuery({
    queryKey: ['section-judgments', actId, sec, limit],
    queryFn: () => unwrap(api.GET('/api/v1/statutes/{act_id}/sections/{sec}/judgments', { params: { path: { act_id: actId, sec }, query: { limit } } })),
    retry: (count, err) => count < 1 && !isStatus(err, 404),
    staleTime: 10 * 60_000,
  });
}
