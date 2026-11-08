import { FIR_FIELDS, REANALYSIS_FIELDS, type FirCorrections, type StoredCorrections } from '@lawassist/providers';

/**
 * Applies user corrections to a stored FIR analysis (TRD §8.5; BE-26). Party / reference fields
 * replace the values in `fir` at once. Dates and sections are recorded in `corrections` and mark
 * the analysis `needsReanalysis`, because the delay, the section rows and Schedule II tags derive
 * from them and only `POST …/reanalyze` recomputes those.
 */
type StoredFir = Record<string, unknown>;
export interface CorrectableAnalysis {
  documentKind: 'FIR';
  fir: StoredFir;
  corrections?: StoredCorrections;
  [k: string]: unknown;
}

export const isCorrectable = (v: unknown): v is CorrectableAnalysis =>
  !!v && typeof v === 'object' && (v as CorrectableAnalysis).documentKind === 'FIR' && typeof (v as CorrectableAnalysis).fir === 'object';

export function applyCorrections(stored: CorrectableAnalysis, c: FirCorrections, now: Date): { analysis: CorrectableAnalysis; changed: string[]; needsReanalysis: boolean } {
  const fir: StoredFir = { ...stored.fir };
  const changed: string[] = [];
  for (const f of FIR_FIELDS) {
    if (c[f] === undefined) continue;
    fir[f] = c[f];
    changed.push(f);
  }

  const prev = stored.corrections;
  const next: StoredCorrections = {
    ...(prev ?? {}),
    fields: [...new Set([...(prev?.fields ?? []), ...changed])],
    correctedAt: now.toISOString(),
    needsReanalysis: prev?.needsReanalysis ?? false,
  };
  for (const f of REANALYSIS_FIELDS) {
    if (c[f] === undefined) continue;
    (next as unknown as Record<string, unknown>)[f] = c[f];
    changed.push(f);
    next.fields = [...new Set([...next.fields, f])];
    next.needsReanalysis = true;
  }
  return { analysis: { ...stored, fir, corrections: next }, changed, needsReanalysis: next.needsReanalysis };
}
