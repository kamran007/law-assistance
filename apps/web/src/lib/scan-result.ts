'use client';

import type { paths } from '@lawassist/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './api';
import { caseKeys, isStatus } from './cases';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
export type ArtifactDetail = Json<paths['/api/v1/cases/{id}/artifacts/{art_id}']['get']['responses'][200]>;
export type FirCorrectionsBody = NonNullable<paths['/api/v1/cases/{id}/artifacts/{art_id}']['patch']['requestBody']>['content']['application/json'];

/*
 * Shapes the worker stores in `structured_analysis` / `role_analysis` (apps/worker/src/analysis:
 * StoredAnalysis, RoleAnalysisRecord). The API returns them as opaque JSON, so the screen reads
 * them defensively: anything missing is shown as "not stated", never guessed.
 */
export interface FirDateTime {
  date: string;
  time: string | null;
  approximate: boolean;
  flags: string[];
}
export interface ScheduleTags {
  isCognizable: boolean;
  isBailable: boolean;
  isCompoundable: boolean;
  maxPunishment: string;
  triableByCourt: string;
  offenseDescription: string | null;
  matchedSection: string;
}
export interface AnalysedSection {
  key: string;
  section: string;
  subsection: string | null;
  act: { key: string; name: string } | null;
  actInferred: boolean;
  source: 'DETECTOR' | 'DETECTOR_AND_LLM' | 'LLM_QUOTE_IN_TEXT' | 'USER_CORRECTED';
  scheduleStatus: 'VERIFIED' | 'NOT_IN_VERIFIED_SCHEDULE';
  schedule: ScheduleTags | null;
}
export interface StoredAnalysis {
  documentKind?: 'FIR';
  occurrence: FirDateTime | null;
  reported: FirDateTime | null;
  filingDelay: { minutes: number | null; days: number | null; basis: 'DATETIME' | 'DATE' | 'UNKNOWN'; warning: string | null };
  scheduleDate: string;
  sections: AnalysedSection[];
  fir?: {
    police_station: string | null;
    district: string | null;
    fir_number: string | null;
    gr_number: string | null;
    place_of_occurrence: string | null;
    informant: { name: string | null; address: string | null } | null;
    accused: { name: string; role_in_allegation: string | null }[];
    witnesses: { name: string }[];
    narrative_summary?: string;
    occurrence_datetime_raw: string | null;
    reported_datetime_raw: string | null;
  };
  corrections?: { needsReanalysis: boolean; fields: string[]; occurrence_datetime?: string | null; reported_datetime?: string | null; cited_sections?: { act_hint: string | null; section: string }[] };
}

type Ingredient = { ingredient: string; status: 'ALLEGED' | 'NOT_ALLEGED' | 'UNCLEAR'; source_ids: number[] };
export interface CitizenContent {
  summary: string;
  sections: { section_ref: string; plain_explanation: string; source_ids: number[] }[];
  next_steps: { step: string; source_ids: number[] }[];
}
export interface LawyerContent {
  sections: { section_ref: string; ingredients: (Ingredient & { evidence_in_fir: string | null })[] }[];
  delay: { assessment: 'NO_DELAY' | 'EXPLAINED' | 'UNEXPLAINED' | 'UNKNOWN'; note: string; evidence_in_fir: string | null };
  grounds: { kind: 'BAIL' | 'QUASHMENT' | 'OTHER'; ground: string; source_ids: number[] }[];
}
export interface JudgeContent {
  sections: { section_ref: string; ingredients: (Ingredient & { allegation: string | null })[] }[];
  observations: { text: string; source_ids: number[] }[];
}
export type RoleAnalysis =
  | { status: 'READY'; role: 'CITIZEN' | 'LAWYER' | 'JUDGE'; sources: { n: number; sectionRef: string; versionNumber: number; currentTextUsed: boolean }[]; content: CitizenContent | LawyerContent | JudgeContent; flags: string[] }
  | { status: 'UNAVAILABLE'; reason: string; role: string }
  | { status: 'FAILED'; code: string; role: string };

/** `section_ref` as the worker builds it: `ACT_KEY:sectionKey`. */
export const sectionRef = (s: Pick<AnalysedSection, 'act' | 'key'>) => `${s.act?.key ?? 'UNKNOWN_ACT'}:${s.key}`;

/** Below this OCR confidence the screen asks the user to review the text (App Flow §9.3). */
export const LOW_OCR_CONFIDENCE = 0.8;

export const artifactKey = (caseId: string, artId: string) => [...caseKeys.artifacts(caseId), artId] as const;

export function useArtifactDetail(caseId: string, artId: string) {
  return useQuery({
    queryKey: artifactKey(caseId, artId),
    queryFn: () => unwrap(api.GET('/api/v1/cases/{id}/artifacts/{art_id}', { params: { path: { id: caseId, art_id: artId } } })),
    retry: (count, err) => count < 1 && !isStatus(err, 404),
  });
}

/** Field corrections (TRD §8.5): If-Match on the artifact version; 409 when busy, 412 when stale. */
export function useCorrectArtifact(caseId: string, artId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ version, body }: { version: number; body: FirCorrectionsBody }) =>
      unwrap(api.PATCH('/api/v1/cases/{id}/artifacts/{art_id}', { params: { path: { id: caseId, art_id: artId } }, body, headers: { 'if-match': `"${version}"` } })),
    onSuccess: (updated) => qc.setQueryData(artifactKey(caseId, artId), updated),
    onError: (err) => {
      if (isStatus(err, 412) || isStatus(err, 409)) void qc.invalidateQueries({ queryKey: artifactKey(caseId, artId) });
    },
  });
}

/** Re-runs dates, sections, Schedule II and the role analysis with the corrections (no new extraction). */
export function useReanalyze(caseId: string, artId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/cases/{id}/artifacts/{art_id}/reanalyze', { params: { path: { id: caseId, art_id: artId } } })),
    onSuccess: (a) => {
      qc.setQueryData<ArtifactDetail>(artifactKey(caseId, artId), (d) => (d ? { ...d, processing_status: a.processing_status, version: a.version } : d));
      void qc.invalidateQueries({ queryKey: caseKeys.artifacts(caseId), exact: true });
    },
  });
}

/**
 * Opens the original upload in a new tab. The tab is opened synchronously in the click handler
 * (browsers block windows opened after an await), then pointed at the short-lived signed link.
 */
export async function openOriginal(caseId: string, artId: string, win: Pick<Window, 'open'> = window): Promise<void> {
  const tab = win.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  try {
    const { url } = await unwrap(api.GET('/api/v1/cases/{id}/artifacts/{art_id}/original', { params: { path: { id: caseId, art_id: artId } } }));
    if (tab) tab.location.href = url;
    else win.open(url, '_blank', 'noopener');
  } catch (err) {
    tab?.close();
    throw err;
  }
}
