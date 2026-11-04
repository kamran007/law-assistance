/**
 * Redis keys shared by the worker (writer) and the API (reader) for statute read caching
 * (TRD §11.3). Cached section reads include the Act's generation in their key; the scraper bumps
 * the generation after every committed sync of that Act, so old entries are never read again and
 * simply expire.
 */
export const STATUTE_CACHE_PREFIX = 'statutes:v1';

/** Counter bumped by the scraper after each committed sync of an Act. */
export function statuteGenerationKey(bdlawsActId: number): string {
  return `${STATUTE_CACHE_PREFIX}:gen:${bdlawsActId}`;
}
