import type { Db } from '@lawassist/db';
import { filingDelay, mergeCitedSections, parseFirDateTime, type FilingDelay, type FirDateTime, type LlmCitedSection, type RejectedSection } from '@lawassist/legal-text';
import { joinScheduleII, type TaggedSection } from './schedule';

/**
 * Scan pipeline stages 4–5 (TRD §8.2, BE-24): deterministic post-processing of the FIR extraction
 * (stage 3, BE-23) and the Schedule II join. Pure apart from the read-only schedule query, so
 * `POST /reanalyze` (TRD §8.5) can re-run it on corrected fields.
 */

/** The fields of `FirExtractionSchema` (TRD §8.3) that stages 4–5 read. */
export interface FirExtractionInput {
  occurrence_datetime: string | null;
  reported_datetime: string | null;
  cited_sections: LlmCitedSection[];
}

export interface StructuredAnalysisV1 {
  version: 1;
  occurrence: FirDateTime | null;
  reported: FirDateTime | null;
  filingDelay: FilingDelay;
  /** Date the Schedule II rows were chosen for, and where it came from. */
  scheduleDate: string;
  scheduleDateBasis: 'OCCURRENCE' | 'REPORTED' | 'TODAY';
  sections: TaggedSection[];
  /** LLM-proposed sections that the document does not support (kept for audit, not shown as findings). */
  rejectedSections: RejectedSection[];
}

export interface PostProcessInput {
  /** `raw_extracted_text` after Bijoy conversion. */
  text: string;
  extraction: FirExtractionInput;
  /** Injected for tests; Dhaka "today" otherwise. */
  today?: string;
}

const dhakaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

export async function postProcessFir(db: Db, input: PostProcessInput): Promise<StructuredAnalysisV1> {
  const occurrence = parseFirDateTime(input.extraction.occurrence_datetime);
  const reported = parseFirDateTime(input.extraction.reported_datetime);
  // FIRs: an unnamed Act is the Penal Code, flagged act_inferred (TRD §8.4).
  const merged = mergeCitedSections(input.text, input.extraction.cited_sections, { defaultAct: 'PENAL_CODE' });

  const scheduleDateBasis = occurrence ? 'OCCURRENCE' : reported ? 'REPORTED' : 'TODAY';
  const scheduleDate = occurrence?.date ?? reported?.date ?? input.today ?? dhakaToday();
  const sections = await joinScheduleII(db, merged.sections, scheduleDate);

  return {
    version: 1,
    occurrence,
    reported,
    filingDelay: filingDelay(occurrence, reported),
    scheduleDate,
    scheduleDateBasis,
    sections,
    rejectedSections: merged.rejected,
  };
}
