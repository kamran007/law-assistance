import { eq } from 'drizzle-orm';
import { scoped, users, type CaseArtifact, type Db } from '@lawassist/db';
import type { LlmCitedSection } from '@lawassist/legal-text';
import { LlmNotConfiguredError, LlmRefusalError, LlmTruncatedError, type AnalysisJob, type LlmClient, type StoredCorrections } from '@lawassist/providers';
import { DocumentTooLongError, extractFir, type FirExtraction } from './extract';
import { postProcessFir, type StructuredAnalysisV1 } from './post-process';
import { generateRoleAnalysis, type AnalysisRole, type Lang, type ValidatedRoleAnalysis } from './roles';
import { loadPinnedSources } from './sources';
import { trackedRepo, type StatusEventDeps } from '../status-events';

/**
 * Consumer of the `analysis` queue (TRD §8.2 stages 3–6; BE-23, BE-24, BE-25). Runs as the
 * document's owner through `scoped()`.
 *
 *   EXTRACTING → (3: LLM extraction) → SCHEDULE_LOOKUP → (4–5: deterministic) → ANALYZING
 *   [structured_analysis saved and visible] → (6: role analysis) → READY [role_analysis saved]
 *
 * A retry after an outage resumes where the job stopped: ANALYZING with a saved structured
 * analysis re-runs stage 6 only. A stage-6 failure caused by the document (refusal, truncation)
 * still ends in READY, because the deterministic result stands on its own.
 */
export interface AnalysisDeps extends Pick<StatusEventDeps, 'events' | 'push'> {
  db: Db;
  llm: LlmClient;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export type AnalysisOutcome = { status: 'READY'; analysed: boolean; roleAnalysis?: RoleAnalysisRecord['status'] } | { status: 'FAILED'; code: string } | { status: 'SKIPPED'; reason: string };

/** Document types that carry an FIR-style account with offences and dates. */
const FIR_LIKE: CaseArtifact['artifactType'][] = ['FIR_SCAN', 'CHARGE_SHEET'];
const STARTABLE: CaseArtifact['processingStatus'][] = ['EXTRACTING', 'SCHEDULE_LOOKUP', 'ANALYZING'];

export type StoredAnalysis = StructuredAnalysisV1 & {
  documentKind: 'FIR';
  fir: Omit<FirExtraction, 'cited_sections' | 'occurrence_datetime' | 'reported_datetime'> & {
    occurrence_datetime_raw: string | null;
    reported_datetime_raw: string | null;
  };
  extractionModel: string;
  /** Stage 3's section proposals, kept so a reanalysis can merge again without a new LLM call. */
  llmCitedSections?: LlmCitedSection[];
  /** User corrections (TRD §8.5), written by the API's PATCH. */
  corrections?: StoredCorrections;
};

export type RoleAnalysisRecord =
  | ({ status: 'READY' } & ValidatedRoleAnalysis)
  | { status: 'UNAVAILABLE'; reason: 'NO_SECTION_TEXT'; role: AnalysisRole }
  | { status: 'FAILED'; code: string; role: AnalysisRole };

export async function processAnalysisJob(deps: AnalysisDeps, job: AnalysisJob): Promise<AnalysisOutcome> {
  const repo = trackedRepo(deps.db, job.ownerUserId, deps);
  const artifact = await repo.artifacts.findById(job.artifactId);
  if (!artifact) return { status: 'SKIPPED', reason: 'deleted or not found' };
  if (!artifact.processingStatus || !STARTABLE.includes(artifact.processingStatus)) return { status: 'SKIPPED', reason: `status ${artifact.processingStatus}` };
  const text = artifact.rawExtractedText;
  if (!text?.trim()) return fail(repo, job.artifactId, 'UNREADABLE_DOCUMENT');

  if (!FIR_LIKE.includes(artifact.artifactType)) {
    // Seizure lists, court orders …: their own schemas come later. The text is ready to read.
    await repo.artifacts.setProcessing(job.artifactId, { processingStatus: 'READY', processingError: null });
    return { status: 'READY', analysed: false };
  }

  try {
    const stored = artifact.structuredAnalysis as StoredAnalysis | null;
    let analysis: StoredAnalysis | null = null;
    if (job.mode === 'reanalyze') {
      // TRD §8.5: stages 4–6 again from the stored extraction plus the user's corrections; no LLM
      // extraction. Deterministic, so a retry simply recomputes.
      if (!stored) return { status: 'SKIPPED', reason: 'nothing to reanalyze' };
      analysis = await reanalyze(deps.db, text, stored);
      if (!(await repo.artifacts.setProcessing(job.artifactId, { processingStatus: 'ANALYZING', processingError: null, structuredAnalysis: analysis }))) {
        return { status: 'SKIPPED', reason: 'deleted during processing' };
      }
    } else if (artifact.processingStatus === 'ANALYZING') {
      // A retry after a stage-6 failure: stages 3–5 are already saved.
      analysis = stored;
    }
    if (!analysis) {
      const { extraction, model } = await extractFir(deps.llm, text);
      if (!(await repo.artifacts.setProcessing(job.artifactId, { processingStatus: 'SCHEDULE_LOOKUP' }))) return { status: 'SKIPPED', reason: 'deleted during processing' };
      const post = await postProcessFir(deps.db, { text, extraction });
      analysis = { ...post, documentKind: 'FIR', fir: firFields(extraction), extractionModel: model, llmCitedSections: extraction.cited_sections };
      // Deterministic results are visible from here on, while stage 6 runs.
      if (!(await repo.artifacts.setProcessing(job.artifactId, { processingStatus: 'ANALYZING', processingError: null, structuredAnalysis: analysis }))) {
        return { status: 'SKIPPED', reason: 'deleted during processing' };
      }
    }

    // Stage 6.
    const roleAnalysis = await runRoleAnalysis(deps, job.ownerUserId, text, analysis);
    if (!(await repo.artifacts.setProcessing(job.artifactId, { processingStatus: 'READY', processingError: null, roleAnalysis }))) {
      return { status: 'SKIPPED', reason: 'deleted during processing' };
    }
    // Ids, counts and flags only: never document text or extracted names (TRD §12.3).
    deps.log.info(
      {
        artifactId: job.artifactId,
        sections: analysis.sections.length,
        rejected: analysis.rejectedSections.length,
        verified: analysis.sections.filter((s) => s.scheduleStatus === 'VERIFIED').length,
        roleAnalysis: roleAnalysis.status,
        roleFlags: roleAnalysis.status === 'READY' ? roleAnalysis.flags : [],
      },
      'analysis ready',
    );
    return { status: 'READY', analysed: true, roleAnalysis: roleAnalysis.status };
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) return fail(repo, job.artifactId, 'LLM_NOT_CONFIGURED');
    if (err instanceof LlmRefusalError) return fail(repo, job.artifactId, 'LLM_REFUSED');
    if (err instanceof LlmTruncatedError) return fail(repo, job.artifactId, 'EXTRACTION_TRUNCATED');
    if (err instanceof DocumentTooLongError) return fail(repo, job.artifactId, 'DOCUMENT_TOO_LONG');
    throw err; // provider outage, open circuit, DB: BullMQ retries, then PROCESSING_ERROR
  }
}

/** The analysis follows the owner's EFFECTIVE role (a pending lawyer still gets the citizen view). */
async function ownerProfile(db: Db, userId: string): Promise<{ role: AnalysisRole; language: Lang }> {
  const [u] = await db.select({ role: users.role, language: users.preferredLanguage }).from(users).where(eq(users.userId, userId)).limit(1);
  const role: AnalysisRole = u?.role === 'LAWYER' || u?.role === 'JUDGE' ? u.role : 'CITIZEN';
  return { role, language: u?.language ?? 'BN' };
}

async function runRoleAnalysis(deps: AnalysisDeps, ownerUserId: string, text: string, analysis: StoredAnalysis): Promise<RoleAnalysisRecord> {
  const { role, language } = await ownerProfile(deps.db, ownerUserId);
  const sources = await loadPinnedSources(deps.db, analysis.sections, analysis.scheduleDate);
  // The audit and the matrix are built from section text; without any, there is nothing to cite.
  if (!sources.length && role !== 'CITIZEN') return { status: 'UNAVAILABLE', reason: 'NO_SECTION_TEXT', role };
  try {
    return { status: 'READY', ...(await generateRoleAnalysis(deps.llm, { role, language, firText: text, analysis, sources })) };
  } catch (err) {
    // Answers about this document: record them and keep the deterministic result.
    if (err instanceof LlmRefusalError) return { status: 'FAILED', code: 'LLM_REFUSED', role };
    if (err instanceof LlmTruncatedError) return { status: 'FAILED', code: 'ANALYSIS_TRUNCATED', role };
    if (err instanceof LlmNotConfiguredError) return { status: 'FAILED', code: 'LLM_NOT_CONFIGURED', role };
    throw err;
  }
}

/** Stages 4–5 on stored data: corrected dates / sections win over the extracted ones. */
async function reanalyze(db: Db, text: string, stored: StoredAnalysis): Promise<StoredAnalysis> {
  const c = stored.corrections;
  const post = await postProcessFir(db, {
    text,
    extraction: {
      occurrence_datetime: c && 'occurrence_datetime' in c ? (c.occurrence_datetime ?? null) : stored.fir.occurrence_datetime_raw,
      reported_datetime: c && 'reported_datetime' in c ? (c.reported_datetime ?? null) : stored.fir.reported_datetime_raw,
      cited_sections: stored.llmCitedSections ?? [],
    },
    ...(c?.cited_sections ? { userSections: c.cited_sections } : {}),
  });
  return { ...stored, ...post, ...(c ? { corrections: { ...c, needsReanalysis: false } } : {}) };
}

function firFields(x: FirExtraction): StoredAnalysis['fir'] {
  // The sections live in the merged, verified list; the raw date strings are kept as such.
  return {
    police_station: x.police_station,
    district: x.district,
    fir_number: x.fir_number,
    gr_number: x.gr_number,
    place_of_occurrence: x.place_of_occurrence,
    informant: x.informant,
    accused: x.accused,
    witnesses: x.witnesses,
    narrative_summary: x.narrative_summary,
    field_confidence: x.field_confidence,
    occurrence_datetime_raw: x.occurrence_datetime,
    reported_datetime_raw: x.reported_datetime,
  };
}

async function fail(repo: ReturnType<typeof scoped>, artifactId: string, code: string): Promise<AnalysisOutcome> {
  await repo.artifacts.setProcessing(artifactId, { processingStatus: 'FAILED', processingError: code });
  return { status: 'FAILED', code };
}
