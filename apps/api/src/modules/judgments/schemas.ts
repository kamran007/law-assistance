import { z } from 'zod';
import { actIdParam } from '../statutes/schemas';

/** Zod contracts for the case-law read API (TRD §5.1, §6A.5; JUD-07). snake_case like the rest. */
const isoDate = z.iso.date();
const division = z.enum(['AD', 'HCD']);

export const judgmentIdParam = z.object({ judgment_id: z.uuid() });

export const judgmentListQuery = z.object({
  /** Words in the parties, key words or summary (Bangla and English). */
  q: z.string().trim().min(2).max(200).optional(),
  division: division.optional(),
  /** Year of the decision (the bulletin year when the decision date is unknown). */
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  /** Judgments linked to this Act (bdlaws id) … */
  act_id: z.coerce.number().int().positive().max(1_000_000).optional(),
  /** … and section (needs act_id). */
  sec: z.string().min(1).max(32).optional(),
  /** Authoring judge or bench member, part of the name. */
  judge: z.string().trim().min(2).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const judgmentSummary = z.object({
  judgment_id: z.string(),
  citation: z.string(),
  parties: z.string(),
  division,
  issue: z.number().int(),
  issue_year: z.number().int(),
  serial: z.number().int(),
  case_number: z.string().nullable(),
  authoring_judge: z.string().nullable(),
  decision_date: isoDate.nullable(),
  key_words: z.string(),
  language: z.enum(['EN', 'BN', 'MIXED']),
  /** False while the text needs review (scanned PDF, OCR pending): metadata only. */
  text_available: z.boolean(),
});

export const judgmentList = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  items: z.array(judgmentSummary),
});

export const linkedSection = z.object({
  /** Null when the Act is not in the corpus (the reference is kept as written). */
  act_id: z.number().int().nullable(),
  act_title: z.string().nullable(),
  sec: z.string().nullable(),
  raw: z.string(),
  paragraphs: z.array(z.string()),
  found_in: z.enum(['KEY_WORDS', 'BODY']),
});

export const judgmentDetail = judgmentSummary.extend({
  bench: z.array(z.string()),
  summary: z.string().nullable(),
  key_ratio_paragraphs: z.array(z.string()),
  decision_date_source: z.enum(['PDF_RULE', 'PDF_LLM', 'MANUAL']).nullable(),
  extraction_status: z.enum(['OK', 'OCR_USED', 'NEEDS_REVIEW']),
  /** Case number, parties, counsel and dates before paragraph 1. */
  preamble: z.string().nullable(),
  /** Paragraphs in order; anchors for citations ("para 12"). Empty when text_available is false. */
  paragraphs: z.array(z.object({ n: z.number().int(), text: z.string() })),
  linked_sections: z.array(linkedSection),
  /** Short-lived link to the stored original PDF; null if it isn't stored. */
  pdf_url: z.string().nullable(),
  source_pdf_url: z.string(),
});

export const sectionJudgmentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const sectionJudgment = judgmentSummary.extend({
  /** Paragraphs of the judgment that cite this section. */
  paragraphs: z.array(z.string()),
  /**
   * The judgment was decided before the current wording of the section took effect (FR-D6):
   * "Decided before this section was amended on {section_amended_on}". Null if the decision date
   * is unknown.
   */
  older_than_current_version: z.boolean().nullable(),
  section_amended_on: isoDate.nullable(),
});

export const sectionJudgments = z.object({
  act_id: z.number().int(),
  sec: z.string(),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  items: z.array(sectionJudgment),
});

export const sectionJudgmentsParams = actIdParam.extend({ sec: z.string().min(1).max(32) });
