import { createHash } from 'node:crypto';
import { CHUNK_MAX_TOKENS, CHUNK_MIN_TOKENS, estimateTokens, splitLong, type ChunkOptions } from './chunker';

/**
 * Judgment chunker (TRD §6A.4; JUD-06): splits `full_text` on `[para n]` boundaries into chunks of
 * about 350–500 tokens (the §6.4 estimator). Every chunk starts with
 * "{parties}, {citation} ({division}) — para {from}–{to}" so it reads on its own; the key-ratio
 * paragraphs always start a new chunk so they can be retrieved by themselves. The text before
 * paragraph 1 (case number, parties, counsel, dates) is its own chunk. Pure and deterministic.
 */
export interface JudgmentChunkInput {
  parties: string;
  citation: string;
  division: 'AD' | 'HCD';
  /** With `[para n]` markers at line starts (JUD-04). */
  fullText: string;
  /** Paragraph numbers of the key ratio (from the list), e.g. ["93"]. */
  keyRatioParagraphs: readonly string[];
}

export interface JudgmentChunk {
  text: string;
  paragraphFrom: number | null;
  paragraphTo: number | null;
}

interface Unit {
  text: string;
  tokens: number;
  para: number | null;
  /** First piece of a paragraph: a split point. */
  starts: boolean;
  /** Must start a chunk (key ratio, first paragraph after the preamble). */
  forced: boolean;
}

const MARKER = /^\[para (\d+)\]/;

export function judgmentChunkHeader(input: Pick<JudgmentChunkInput, 'parties' | 'citation' | 'division'>, from: number | null, to: number | null): string {
  const base = `${input.parties.replace(/\s+/g, ' ').trim()}, ${input.citation} (${input.division})`;
  if (from === null || to === null) return base;
  return `${base} — para ${from === to ? from : `${from}–${to}`}`;
}

/** Paragraphs as written: marker line plus its continuation lines, wraps joined with spaces. */
function paragraphs(fullText: string): { para: number | null; text: string }[] {
  const out: { para: number | null; lines: string[] }[] = [];
  for (const raw of fullText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = MARKER.exec(line);
    if (m) out.push({ para: Number(m[1]), lines: [line] });
    else if (out.length) out.at(-1)!.lines.push(line);
    else out.push({ para: null, lines: [line] });
  }
  return out.map((p) => ({ para: p.para, text: p.lines.join(' ').replace(/\s+/g, ' ') }));
}

export function chunkJudgment(input: JudgmentChunkInput, opts: ChunkOptions = {}): JudgmentChunk[] {
  const est = opts.estimateTokens ?? estimateTokens;
  const max = opts.maxTokens ?? CHUNK_MAX_TOKENS;
  const min = Math.min(opts.minTokens ?? CHUNK_MIN_TOKENS, max);
  // The header's paragraph range is only known afterwards; budget for a wide one.
  const headerTokens = est(judgmentChunkHeader(input, 9999, 9999));
  const budget = Math.max(Math.floor(max / 4), max - headerTokens - 1);
  const minBody = Math.max(0, min - (max - budget));
  const keyRatio = new Set(input.keyRatioParagraphs.map(Number));

  const units: Unit[] = [];
  let seenParagraph = false;
  for (const p of paragraphs(input.fullText)) {
    const forced = p.para !== null && (keyRatio.has(p.para) || !seenParagraph);
    if (p.para !== null) seenParagraph = true;
    const pieces = est(p.text) > budget ? splitLong(p.text, budget, est) : [p.text];
    pieces.forEach((text, i) => units.push({ text, tokens: est(text), para: p.para, starts: i === 0, forced: i === 0 && forced }));
  }

  const chunks: JudgmentChunk[] = [];
  let cur: Unit[] = [];
  let curTokens = 0;
  // A key-ratio paragraph also ends its chunk, so it can be retrieved on its own.
  let closeAfter = false;
  const flush = () => {
    if (!cur.length) return;
    const paras = cur.map((u) => u.para).filter((n): n is number => n !== null);
    const from = paras.length ? Math.min(...paras) : null;
    const to = paras.length ? Math.max(...paras) : null;
    chunks.push({ text: `${judgmentChunkHeader(input, from, to)}\n${cur.map((u) => u.text).join('\n')}`, paragraphFrom: from, paragraphTo: to });
    cur = [];
    curTokens = 0;
  };
  for (const u of units) {
    const overflow = curTokens + u.tokens > budget;
    const niceSplit = u.starts && curTokens >= minBody;
    if (cur.length && (u.forced || overflow || niceSplit || (closeAfter && u.starts))) flush();
    if (u.starts) closeAfter = u.para !== null && keyRatio.has(u.para);
    cur.push(u);
    curTokens += u.tokens;
  }
  flush();
  return chunks;
}

/** Deterministic chunk id from (judgment_id, chunk_index), RFC 9562 v8 like `chunkId`. */
export function judgmentChunkId(judgmentId: string, chunkIndex: number): string {
  const h = createHash('sha256').update(`judgment_chunk:${judgmentId}:${chunkIndex}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
