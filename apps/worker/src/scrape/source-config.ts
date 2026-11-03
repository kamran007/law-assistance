import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * bdlaws.minlaw.gov.bd URL patterns and HTML selectors (TRD §6.1: "keep them in config, not in code").
 *
 * STATUS: the defaults below follow the portal's known layout but were NOT verified against live
 * pages. The DATA-01 spike on 2026-11-03 could not reach the site (requests timed out or reset).
 * Confirm them against the 10 spike Acts and update `scraper/README.md` + this file together.
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
  }),
  /** Text in the title/preamble that marks the Act as repealed. */
  repealedPattern: z.string(),
});

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const DEFAULT_SOURCE_CONFIG: SourceConfig = {
  baseUrl: 'http://bdlaws.minlaw.gov.bd',
  userAgent: 'BD-LawAssist-Crawler/0.1',
  minIntervalMs: 1000, // 1 request/second globally (TRD §6.1)
  requestTimeoutMs: 60_000,
  maxRetries: 4,
  urls: {
    indexPaths: [
      '/laws-of-bangladesh.html',
      '/laws-of-bangladesh-alphabetical-index.html',
      '/laws-of-bangladesh-chronological-index.html',
    ],
    actPrint: '/act-print-{id}.html',
    actDetail: '/act-{id}.html',
    actLinkPattern: String.raw`act-(?:details-|print-)?(\d+)\.html`,
  },
  selectors: {
    title: '.act-title, h3.text-center',
    preamble: '.act-no, .act-date, p.text-center',
    section: '.lineremove, .lineremoves',
    sectionHeading: '.txt-head',
    sectionBody: '.txt-details',
    chapter: '.act-chapter-name, .act-chapter-group > p:first-child',
    footnoteMarker: 'sup',
    footnote: '.footnote li, .footnote p',
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
