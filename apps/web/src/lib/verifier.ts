'use client';

import type { paths } from '@lawassist/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from './api';
import { isStatus } from './cases';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
export type SectionView = Json<paths['/api/v1/statutes/{act_id}/sections/{sec}']['get']['responses'][200]>;
export type SectionVersions = Json<paths['/api/v1/statutes/{act_id}/sections/{sec}/versions']['get']['responses'][200]>;

/** What the verifier shows: a section, optionally as in force on a date (Lawyers / Judges). */
export interface VerifierTarget {
  actId: number;
  sec: string;
  asOf?: string | null;
}

/** Section text (current, or `as_of` for professionals; the API refuses `as_of` for others). */
export function useSectionView(t: VerifierTarget | null) {
  return useQuery({
    queryKey: ['statute-section', t?.actId, t?.sec, t?.asOf ?? null],
    queryFn: () => unwrap(api.GET('/api/v1/statutes/{act_id}/sections/{sec}', { params: { path: { act_id: t!.actId, sec: t!.sec }, query: t!.asOf ? { as_of: t!.asOf } : {} } })),
    enabled: t !== null,
    retry: (count, err) => count < 1 && !isStatus(err, 404) && !isStatus(err, 403),
    staleTime: 10 * 60_000,
  });
}

/** Every version of a section (Lawyers / Judges, FR-A4). */
export function useSectionVersions(actId: number, sec: string, enabled: boolean) {
  return useQuery({
    queryKey: ['statute-section-versions', actId, sec],
    queryFn: () => unwrap(api.GET('/api/v1/statutes/{act_id}/sections/{sec}/versions', { params: { path: { act_id: actId, sec } } })),
    enabled,
    retry: (count, err) => count < 1 && !isStatus(err, 403) && !isStatus(err, 404),
    staleTime: 10 * 60_000,
  });
}

/** "Penal Code, 1860, s. 420" / "… ধারা ৪২০": what Copy citation puts on the clipboard. */
export function citation(actTitle: string, sectionNumber: string, locale: string, asOf?: string | null): string {
  const base = locale === 'bn' ? `${actTitle}, ধারা ${sectionNumber}` : `${actTitle}, s. ${sectionNumber}`;
  if (!asOf) return base;
  return locale === 'bn' ? `${base} (${asOf} তারিখে বলবৎ পাঠ)` : `${base} (as in force on ${asOf})`;
}
