/**
 * FULLTEXT (ngram, BOOLEAN mode) query from free text: every word is required ("+penal +code"), so a
 * result really contains what was typed and can be listed newest first. In ngram BOOLEAN mode each
 * word is matched as a phrase of its ngrams. Operators the user typed are removed; one-letter words
 * ("ও", "a") are dropped; at most 20 words. Empty when nothing is left.
 */
export function requiredWords(q: string): string {
  return q
    .replace(/[+\-<>()~*"@]/g, ' ')
    .split(/\s+/)
    .filter((w) => [...w].length >= 2)
    .slice(0, 20)
    .map((w) => `+${w}`)
    .join(' ');
}

/** List order: newest first (default) or best match first when searching. */
export const SORTS = ['newest', 'relevance'] as const;
export type Sort = (typeof SORTS)[number];
