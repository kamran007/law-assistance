import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * bdlaws.minlaw.gov.bd URL patterns and HTML selectors (TRD §6.1: "keep them in config, not in code").
 *
 * STATUS: verified against live pages on 2026-11-04 (DATA-01 spike, 9 Acts; see `README.md` in this
 * folder). Update the README and this file together when the portal changes.
 * A JSON file passed via SCRAPER_SOURCE_CONFIG can override any field without a code change.
 */
export const sourceConfigSchema = z.object({
  baseUrl: z.string().url(),
  /** Generic product UA (TRD §6.1). No contact details, no browser impersonation. */
  userAgent: z.string().min(3),
  minIntervalMs: z.number().int().min(1000),
  requestTimeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0).max(10),
  urls: z.object({
    /** Index pages scanned for Act links. */
    indexPaths: z.array(z.string()).min(1),
    /** `{id}` is replaced with the bdlaws act id. */
    actPrint: z.string().includes('{id}'),
    actDetail: z.string().includes('{id}'),
    /** Regex (string) whose first group is the act id, matched against hrefs on index pages. */
    actLinkPattern: z.string(),
  }),
  selectors: z.object({
    title: z.string(),
    /** Elements near the title holding "(ACT NO. XLV OF 1860)" and "[6th October, 1860]". */
    preamble: z.string(),
    /** Each element is one section (heading + body). */
    section: z.string(),
    sectionHeading: z.string(),
    sectionBody: z.string(),
    /** Chapter/Part headings; they appear in document order between sections. */
    chapter: z.string(),
    /** Footnote reference markers inside section text. */
    footnoteMarker: z.string(),
    /** Footnote list entries at the end of the Act. */
    footnote: z.string(),
    /** Elements inside a section body that separate paragraphs (in addition to <p>/<li>). */
    lineBreak: z.string(),
    /** Matches a section block that the portal marks as repealed. */
    repealedSection: z.string(),
  }),
  /** Text in the title/preamble that marks the Act as repealed. */
  repealedPattern: z.string(),
});

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const DEFAULT_SOURCE_CONFIG: SourceConfig = {
  baseUrl: 'http://bdlaws.minlaw.gov.bd',
  userAgent: 'BD-LawAssist-Crawler/0.1',
  minIntervalMs: 1000, // 1 request/second globally (TRD §6.1)
  // Print views of large Acts are slow: CrPC took 41 s, the Penal Code 22 s (2026-11-04).
  requestTimeoutMs: 120_000,
  maxRetries: 4,
  urls: {
    // The chronological index (~2.6 MB) links every Act as /act-{id}.html. The main index only
    // links volumes, and the alphabetical index is ~57 MB, so neither is used.
    indexPaths: ['/laws-of-bangladesh-chronological-index.html'],
    actPrint: '/act-print-{id}.html',
    actDetail: '/act-{id}.html',
    actLinkPattern: String.raw`act-(?:details-|print-)?(\d+)\.html`,
  },
  selectors: {
    title: '.bg-act-section h3',
    preamble: '.bg-act-section h4, .publish-date',
    // `.lineremove` (singular) is the title block, not a section.
    section: '.lineremoves',
    sectionHeading: '.txt-head',
    sectionBody: '.txt-details',
    // "Chapter I" + "INTRODUCTION"; the group sits inside the row of the chapter's first section.
    chapter: '.act-chapter-group',
    // Markers are <span class="footnote" title="…"><sup>n</sup></span>; the number is the <sup> text.
    footnoteMarker: 'sup',
    footnote: '.footnoteListAll li.footnoteList',
    lineBreak: '.clbr, .na, br',
    repealedSection: '.repealed, .bn-repealed',
  },
  repealedPattern: String.raw`\[\s*repealed\s*\]|\brepealed\b by|রহিত`,
};

export function loadSourceConfig(path: string | undefined = process.env.SCRAPER_SOURCE_CONFIG): SourceConfig {
  if (!path) return DEFAULT_SOURCE_CONFIG;
  const override = JSON.parse(readFileSync(path, 'utf8')) as Partial<SourceConfig>;
  return sourceConfigSchema.parse({
    ...DEFAULT_SOURCE_CONFIG,
    ...override,
    urls: { ...DEFAULT_SOURCE_CONFIG.urls, ...override.urls },
    selectors: { ...DEFAULT_SOURCE_CONFIG.selectors, ...override.selectors },
  });
}

export function actUrl(cfg: SourceConfig, pattern: 'actPrint' | 'actDetail', actId: number): string {
  return new URL(cfg.urls[pattern].replace('{id}', String(actId)), cfg.baseUrl).toString();
}
