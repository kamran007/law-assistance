import { z } from 'zod';
import { SORTS } from '../../fulltext';

/**
 * Zod contracts for the statute read API (TRD §5.1). JSON uses snake_case like the rest of the API.
 * These move to `packages/contracts` when the web client (WEB-01) starts consuming them.
 */
const isoDate = z.iso.date();

export const actIdParam = z.object({ act_id: z.coerce.number().int().positive().max(1_000_000) });
export const sectionParams = actIdParam.extend({ sec: z.string().min(1).max(32) });

export const statuteListQuery = z.object({
  q: z.string().trim().min(2).max(200).optional(),
  status: z.enum(['ACTIVE', 'REPEALED']).optional(),
  year: z.coerce.number().int().min(1700).max(2100).optional(),
  /** Newest enactment first (default), or best title match first. */
  sort: z.enum(SORTS).default('newest'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const sectionQuery = z.object({
  /** Point-in-time lookup (FR-A4). LAWYER/JUDGE only. */
  as_of: isoDate.optional(),
});

export const statuteSummary = z.object({
  act_id: z.number().int(),
  title: z.string(),
  title_en: z.string().nullable(),
  title_bn: z.string().nullable(),
  act_number: z.string().nullable(),
  enacted_date: isoDate.nullable(),
  status: z.enum(['ACTIVE', 'REPEALED']),
  language: z.enum(['BN', 'EN']),
});

export const statuteList = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  items: z.array(statuteSummary),
});

export const statuteDetail = statuteSummary.extend({
  source_url: z.string(),
  last_synced_at: z.string().nullable(),
  chapters: z.array(
    z.object({
      chapter: z.string().nullable(),
      sections: z.array(z.object({ sec: z.string(), section_number: z.string(), heading: z.string().nullable() })),
    }),
  ),
});

export const footnote = z.object({
  action: z.enum(['SUBSTITUTED', 'INSERTED', 'OMITTED', 'OTHER']),
  by_act: z.string().nullable(),
  date: isoDate.nullable(),
  text: z.string(),
});

export const sectionVersion = z.object({
  section_id: z.string(),
  sec: z.string(),
  section_number: z.string(),
  chapter: z.string().nullable(),
  heading: z.string().nullable(),
  /** Verbatim statutory text, footnote markers included; paragraphs separated by "\n". */
  text: z.string(),
  footnotes: z.array(footnote),
  version: z.number().int(),
  is_current: z.boolean(),
  valid_from: isoDate,
  valid_to: isoDate.nullable(),
  /** How valid_from was derived; DETECTED_ON_SYNC means the date is approximate (TRD §4.2). */
  valid_from_source: z.enum(['AMENDMENT_FOOTNOTE', 'ENACTMENT_DATE', 'DETECTED_ON_SYNC']),
});

/** Deterministic CrPC Schedule II tags (FR-B3); never AI-generated. */
export const scheduleStrip = z.object({
  is_cognizable: z.boolean(),
  is_bailable: z.boolean(),
  is_compoundable: z.boolean(),
  max_punishment: z.string(),
  triable_by_court: z.string(),
  effective_from: isoDate,
});

export const sectionResponse = z.object({
  act: statuteSummary,
  section: sectionVersion,
  /** The date the text was looked up for; null = current law. */
  law_as_of: isoDate.nullable(),
  /** Version number of the current text, so the client can show "current wording differs". */
  current_version: z.number().int().nullable(),
  schedule_ii: scheduleStrip.nullable(),
});

export const versionsResponse = z.object({
  act: statuteSummary,
  sec: z.string(),
  versions: z.array(sectionVersion),
});
