import { z } from 'zod';

/**
 * User corrections to an analysed FIR (TRD §8.5; BE-26): the contract between the API's
 * `PATCH …/artifacts/{id}` (validates and stores) and the worker's `reanalyze` run (applies).
 *
 * Party and reference fields are corrected in place. Dates and sections feed the deterministic
 * stages, so changing them marks the analysis `needsReanalysis` until `POST …/reanalyze` runs.
 * Corrected sections are authoritative: they replace the detector's reading of the text.
 */
const text = (max: number) => z.string().trim().max(max);

export const FirCorrectionsSchema = z
  .object({
    police_station: text(200).nullable().optional(),
    district: text(200).nullable().optional(),
    fir_number: text(100).nullable().optional(),
    gr_number: text(100).nullable().optional(),
    place_of_occurrence: text(500).nullable().optional(),
    informant: z.object({ name: text(200).nullable(), address: text(500).nullable() }).strict().optional(),
    accused: z
      .array(z.object({ name: text(200).min(1), role_in_allegation: text(500).nullable() }).strict())
      .max(100)
      .optional(),
    witnesses: z
      .array(z.object({ name: text(200).min(1) }).strict())
      .max(100)
      .optional(),
    occurrence_datetime: text(200).nullable().optional(),
    reported_datetime: text(200).nullable().optional(),
    cited_sections: z
      .array(z.object({ act_hint: text(200).nullable(), section: text(32).min(1) }).strict())
      .max(50)
      .optional(),
  })
  .strict()
  .refine((c) => Object.keys(c).length > 0, { message: 'At least one field to correct' });

export type FirCorrections = z.infer<typeof FirCorrectionsSchema>;

/** Fields whose change requires re-running stages 4–6. */
export const REANALYSIS_FIELDS = ['occurrence_datetime', 'reported_datetime', 'cited_sections'] as const satisfies readonly (keyof FirCorrections)[];
/** Fields corrected in place in `structured_analysis.fir`. */
export const FIR_FIELDS = ['police_station', 'district', 'fir_number', 'gr_number', 'place_of_occurrence', 'informant', 'accused', 'witnesses'] as const satisfies readonly (keyof FirCorrections)[];

/** What `structured_analysis.corrections` holds: the user's latest values for date / section fields. */
export interface StoredCorrections {
  occurrence_datetime?: string | null;
  reported_datetime?: string | null;
  cited_sections?: { act_hint: string | null; section: string }[];
  /** Every field the user has corrected so far. */
  fields: string[];
  correctedAt: string;
  /** Dates or sections changed since the last deterministic run. */
  needsReanalysis: boolean;
}
