import * as cheerio from 'cheerio';
import type { SourceConfig } from './source-config';

/** Collects bdlaws act ids from an index page (TRD §6.1 discovery). Sorted, unique. */
export function extractActIds(html: string, cfg: SourceConfig): number[] {
  const $ = cheerio.load(html);
  const re = new RegExp(cfg.urls.actLinkPattern);
  const ids = new Set<number>();
  $('a[href]').each((_, el) => {
    const m = re.exec($(el).attr('href') ?? '');
    const id = m?.[1] ? Number(m[1]) : NaN;
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  });
  return [...ids].sort((a, b) => a - b);
}
