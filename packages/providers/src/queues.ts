/**
 * BullMQ queue and job names shared by the API (producer) and the worker (consumer). Payloads
 * carry ids only, never document text (TRD §12.3).
 */
export const SCAN_QUEUE = 'scan';
export const SCAN_JOB = 'scan_pipeline';
/** Stage 3+ of the scan pipeline (entity extraction, Schedule II, role analysis; BE-23..25). */
export const ANALYSIS_QUEUE = 'analysis';
export const ANALYSIS_JOB = 'analyze_document';

export interface DocumentJob {
  artifactId: string;
  ownerUserId: string;
}
