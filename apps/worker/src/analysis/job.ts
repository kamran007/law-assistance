import { scoped, type CaseArtifact, type Db } from '@lawassist/db';
import { LlmNotConfiguredError, LlmRefusalError, LlmTruncatedError, type LlmClient } from '@lawassist/providers';
import { DocumentTooLongError, extractFir, type FirExtraction } from './extract';
import { postProcessFir, type StructuredAnalysisV1 } from './post-process';

/**
 * Consumer of the `analysis` queue (TRD §8.2 stages 3–5; BE-23 + BE-24). Runs as the document's
 * owner through `scoped()`. Stage 6 (role analysis, BE-25) is not built yet, so a finished
 * document goes to READY with `role_analysis` empty; BE-25 will hand over to ANALYZING instead.
 */
export interface AnalysisDeps {
  db: Db;
  llm: LlmClient;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export type AnalysisOutcome = { status: 'READY'; analysed: boolean } | { status: 'FAILED'; code: string } | { status: 'SKIPPED'; reason: string };

/** Document types that carry an FIR-style account with offences and dates. */
const FIR_LIKE: CaseArtifact['artifactType'][] = ['FIR_SCAN', 'CHARGE_SHEET'];
const STARTABLE: CaseArtifact['processingStatus'][] = ['EXTRACTING', 'SCHEDULE_LOOKUP'];

export type StoredAnalysis = StructuredAnalysisV1 & {
  documentKind: 'FIR';
  fir: Omit<FirExtraction, 'cited_sections' | 'occurrence_datetime' | 'reported_datetime'> & {
    occurrence_datetime_raw: string | null;
    reported_datetime_raw: string | null;
  };
  extractionModel: string;
};

export async function processAnalysisJob(deps: AnalysisDeps, job: { artifactId: string; ownerUserId: string }): Promise<AnalysisOutcome> {
  const repo = scoped(deps.db, job.ownerUserId);
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
    const { extraction, model } = await extractFir(deps.llm, text);
    if (!(await repo.artifacts.setProcessing(job.artifactId, { processingStatus: 'SCHEDULE_LOOKUP' }))) return { status: 'SKIPPED', reason: 'deleted during processing' };

    const post = await postProcessFir(deps.db, { text, extraction });
    // The sections live in `post.sections` (merged, verified); the raw date strings are kept as such.
    const { police_station, district, fir_number, gr_number, place_of_occurrence, informant, accused, witnesses, narrative_summary, field_confidence } = extraction;
    const analysis: StoredAnalysis = {
      ...post,
      documentKind: 'FIR',
      fir: {
        police_station,
        district,
        fir_number,
        gr_number,
        place_of_occurrence,
        informant,
        accused,
        witnesses,
        narrative_summary,
        field_confidence,
        occurrence_datetime_raw: extraction.occurrence_datetime,
        reported_datetime_raw: extraction.reported_datetime,
      },
      extractionModel: model,
    };
    if (!(await repo.artifacts.setProcessing(job.artifactId, { processingStatus: 'READY', processingError: null, structuredAnalysis: analysis }))) {
      return { status: 'SKIPPED', reason: 'deleted during processing' };
    }
    // Ids and counts only: never document text or extracted names (TRD §12.3).
    deps.log.info(
      { artifactId: job.artifactId, sections: post.sections.length, rejected: post.rejectedSections.length, verified: post.sections.filter((s) => s.scheduleStatus === 'VERIFIED').length },
      'analysis ready',
    );
    return { status: 'READY', analysed: true };
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) return fail(repo, job.artifactId, 'LLM_NOT_CONFIGURED');
    if (err instanceof LlmRefusalError) return fail(repo, job.artifactId, 'LLM_REFUSED');
    if (err instanceof LlmTruncatedError) return fail(repo, job.artifactId, 'EXTRACTION_TRUNCATED');
    if (err instanceof DocumentTooLongError) return fail(repo, job.artifactId, 'DOCUMENT_TOO_LONG');
    throw err; // provider outage, open circuit, DB: BullMQ retries, then PROCESSING_ERROR
  }
}

async function fail(repo: ReturnType<typeof scoped>, artifactId: string, code: string): Promise<AnalysisOutcome> {
  await repo.artifacts.setProcessing(artifactId, { processingStatus: 'FAILED', processingError: code });
  return { status: 'FAILED', code };
}
