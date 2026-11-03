import { createHash } from 'node:crypto';
import { normalizeForHash } from './normalize';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Content hash of a section version: heading + body (TRD §6.2 step 3). */
export function hashSectionContent(heading: string, body: string): string {
  return sha256(`${normalizeForHash(heading)}\n${normalizeForHash(body)}`);
}

/** Separate hash for footnotes so footnote-only changes are distinguishable. */
export function hashFootnotes(footnotes: readonly string[]): string {
  return sha256(footnotes.map(normalizeForHash).join('\n'));
}
