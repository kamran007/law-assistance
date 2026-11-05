/**
 * OCR behind a vendor-neutral interface (TRD §2, §8.2 stage 2; decision D1). The Google Vision
 * implementation is BE-20 (needs PRE-04). Pages are pre-processed PNG images, one per page.
 */
export interface OcrPageResult {
  text: string;
  /** 0–1, as reported by the engine. */
  confidence: number;
}

export interface OcrProvider {
  read(pages: Uint8Array[], opts: { hints: string[] }): Promise<OcrPageResult[]>;
}

/** Raised when no OCR engine is configured; the scan pipeline reports it as a clear failure. */
export class OcrNotConfiguredError extends Error {
  constructor() {
    super('No OCR provider is configured');
    this.name = 'OcrNotConfiguredError';
  }
}

/** Until BE-20: documents that need OCR fail with OCR_NOT_CONFIGURED instead of hanging. */
export const notConfiguredOcr: OcrProvider = {
  read: async () => {
    throw new OcrNotConfiguredError();
  },
};
