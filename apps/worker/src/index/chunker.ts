import { createHash } from 'node:crypto';
import { classifyLine, stripSectionNumber } from '../scrape/parser';

/**
 * Section chunker (DATA-06, TRD §4.2): about 350–500 tokens per chunk, split on sub-section and
 * proviso boundaries, and every chunk starts with the Act/section heading so it reads on its own.
 * Pure and deterministic: the same section always gives the same chunks and the same chunk ids,
 * which is what makes outbox replays idempotent.
 */
export interface ChunkInput {
  actTitle: string | null;
  sectionNumber: string;
  marginalHeading: string | null;
  /** Paragraphs joined with "\n" (as stored by the scraper). */
  contentBody: string;
}

export interface ChunkOptions {
  minTokens?: number;
  maxTokens?: number;
  estimateTokens?: (text: string) => number;
}

export const CHUNK_MIN_TOKENS = 350;
export const CHUNK_MAX_TOKENS = 500;

const LATIN_WORD = /[A-Za-z]+/g;
const BENGALI_WORD = /\p{Script=Bengali}+/gu;
/** Numbers and punctuation. Combining marks (\p{M}: Bangla vowel signs, virama) belong to words. */
const OTHER_TOKEN = /[0-9০-৯]+|[^\s\p{L}\p{M}\p{N}]/gu;

/**
 * Approximate bge-m3 (XLM-R SentencePiece) token count. No JS tokenizer for the model is available,
 * so this errs on the high side: English ≈ 1.3 pieces/word, Bangla ≈ 2.2 pieces/word, and each
 * number or punctuation mark counts as one. Chunk size only affects retrieval granularity:
 * TEI truncates anything over the model limit (8,192), so a wrong estimate never loses text.
 */
export function estimateTokens(text: string): number {
  const latin = text.match(LATIN_WORD)?.length ?? 0;
  const bengali = text.match(BENGALI_WORD)?.length ?? 0;
  const other = text.match(OTHER_TOKEN)?.length ?? 0;
  return Math.ceil(latin * 1.3 + bengali * 2.2 + other);
}

export function chunkHeader(input: Pick<ChunkInput, 'actTitle' | 'sectionNumber' | 'marginalHeading'>): string {
  const sec = `s. ${input.sectionNumber}`;
  const head = [input.actTitle, input.marginalHeading ? `${sec}: ${input.marginalHeading}` : sec].filter(Boolean);
  return head.join(' | ');
}

interface Unit {
  text: string;
  tokens: number;
  /** Starts a sub-section, proviso, explanation or illustration: a preferred split point. */
  boundary: boolean;
}

export function chunkSection(input: ChunkInput, opts: ChunkOptions = {}): string[] {
  const est = opts.estimateTokens ?? estimateTokens;
  const max = opts.maxTokens ?? CHUNK_MAX_TOKENS;
  const min = Math.min(opts.minTokens ?? CHUNK_MIN_TOKENS, max);
  const header = chunkHeader(input);
  // Keep at least a quarter of the budget for body text even under a very long heading.
  const budget = Math.max(Math.floor(max / 4), max - est(header) - 1);
  const minBody = Math.max(0, min - (max - budget));

  const lines = input.contentBody.split('\n').map((l) => l.trim()).filter(Boolean);
  const units: Unit[] = lines.flatMap((line, i) => {
    const kind = classifyLine(i === 0 ? stripSectionNumber(line) : line).kind;
    const pieces = est(line) > budget ? splitLong(line, budget, est) : [line];
    return pieces.map((text, j) => ({ text, tokens: est(text), boundary: j === 0 && i > 0 && kind !== 'TEXT' }));
  });

  const chunks: string[] = [];
  let cur: Unit[] = [];
  let curTokens = 0;
  const flush = () => {
    if (cur.length) chunks.push(`${header}\n${cur.map((u) => u.text).join('\n')}`);
    cur = [];
    curTokens = 0;
  };
  for (const u of units) {
    const overflow = curTokens + u.tokens > budget;
    const niceSplit = u.boundary && curTokens >= minBody;
    if (cur.length && (overflow || niceSplit)) flush();
    cur.push(u);
    curTokens += u.tokens;
  }
  flush();
  // A section with no body text still gets one chunk, so it remains findable by its heading.
  return chunks.length ? chunks : [header];
}

/** Splits an over-long paragraph at sentence ends, then at word boundaries as a last resort. */
function splitLong(line: string, budget: number, est: (t: string) => number): string[] {
  const out: string[] = [];
  let cur = '';
  const push = (piece: string) => {
    const next = cur ? `${cur} ${piece}` : piece;
    if (cur && est(next) > budget) {
      out.push(cur);
      cur = piece;
    } else {
      cur = next;
    }
  };
  for (const sentence of line.split(/(?<=[.;:।])\s+/u)) {
    if (est(sentence) <= budget) {
      push(sentence);
      continue;
    }
    for (const word of sentence.split(/\s+/)) push(word);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Deterministic chunk id: a UUID derived from (section_id, chunk_index). Re-chunking or replaying
 * an outbox event therefore writes the same Qdrant point id and the same `section_chunks` key.
 * Formatted as RFC 9562 version 8 (custom) so it is a valid UUID for Qdrant and BINARY(16).
 */
export function chunkId(sectionId: string, chunkIndex: number): string {
  const h = createHash('sha256').update(`section_chunk:${sectionId}:${chunkIndex}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x80; // version 8
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
