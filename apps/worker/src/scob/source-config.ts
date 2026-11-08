/**
 * Supreme Court Online Bulletin (SCOB) URLs and patterns (SRS §4.4, TRD §6A).
 *
 * STATUS: checked against live pages on 2026-11-08 (JUD-01 spike; see README.md in this folder):
 * index, list pages of issues 5, 14 and 20 (both templates, both divisions) and six judgment PDFs.
 * Update the README and this file together when the site changes.
 */
export const SCOB_SOURCE_CONFIG = {
  /** Pages and PDF hrefs are relative to this. */
  baseUrl: 'https://www.supremecourt.gov.bd/web/',
  indexPath: '?page=bulletin.php&menu=10&lang=',
  userAgent: 'BD-LawAssist-Crawler/0.1',
  /** No robots.txt on the site (404, 2026-11-08); stay at one request every 3 s. */
  minIntervalMs: 3000,
  /** Judgment PDFs are up to a few MB (4.3 MB seen). */
  requestTimeoutMs: 120_000,
  /**
   * Division list links on the index. Issues 1–14 use the generic template
   * (`bulletin_list.php`), 15+ a per-issue page (`bulletin_list_AD_20.php`). Both carry
   * `div_id` (1 = AD, 2 = HCD) and `issue`.
   */
  listLinkPattern: /\?page=bulletin\/bulletin_list(?:_(?:AD|HD)_\d+)?\.php&(?:amp;)?menu=00&(?:amp;)?div_id=([12])&(?:amp;)?issue=(\d+)/,
  /** Full-issue PDF on the index: `../resources/bulletin/20_SCOB_2025.pdf` gives issue and year. */
  issuePdfPattern: /\.\.\/resources\/bulletin\/(\d+)_SCOB_(\d{4})\.pdf/,
  /**
   * Judgment PDF names are NOT predictable across issues ("1. 20 SCOB AD-1.pdf",
   * "01. 20 SCOB HCD.pdf", "5_SCOB_HCD_1.pdf", "14_SCOB_HD_1.pdf"): always take the href from
   * the row, never build it.
   */
  judgmentPdfHref: /\.\.\/resources\/bulletin\/[^"']+\.pdf$/i,
} as const;

export type Division = 'AD' | 'HCD';
export const divisionOf = (divId: string): Division => (divId === '1' ? 'AD' : 'HCD');
