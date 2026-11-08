/**
 * Word-level diff for the version history (App Flow §7.1: "old text with a diff highlight against
 * the current version"). Longest common subsequence over words, whitespace kept with each word so
 * the text reads exactly as published. Very long pairs fall back to "all removed / all added"
 * rather than freezing the page.
 */
export type DiffPart = { kind: 'same' | 'removed' | 'added'; text: string };

/** Above this many word comparisons the diff is skipped (≈ 2 000 × 2 000 words). */
export const MAX_DIFF_CELLS = 4_000_000;

const tokenize = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_DIFF_CELLS) return merge([{ kind: 'removed', text: before }, { kind: 'added', text: after }]);

  // lcs[i][j] = LCS length of a[i..] and b[j..], stored row-major in one typed array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const out: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) out.push({ kind: 'removed', text: a[i++]! });
    else out.push({ kind: 'added', text: b[j++]! });
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++]! });
  while (j < m) out.push({ kind: 'added', text: b[j++]! });
  return merge(groupChanges(out));
}

/**
 * Readability: whitespace kept between two changed words belongs to the change ("seven years" →
 * "ten years" is one block, not two), and each block shows all removed words, then all added.
 * Old text = same + removed parts, new text = same + added parts, both still in order.
 */
function groupChanges(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let removed = '';
  let added = '';
  const flush = () => {
    if (removed) out.push({ kind: 'removed', text: removed });
    if (added) out.push({ kind: 'added', text: added });
    removed = added = '';
  };
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!;
    const inChange = removed !== '' || added !== '';
    const next = parts[k + 1];
    if (p.kind === 'same' && inChange && /^\s+$/.test(p.text) && next && next.kind !== 'same') {
      removed += p.text;
      added += p.text;
    } else if (p.kind === 'removed') removed += p.text;
    else if (p.kind === 'added') added += p.text;
    else {
      flush();
      out.push(p);
    }
  }
  flush();
  return out;
}

/** Joins neighbours of the same kind; whitespace-only changes between two equal runs count as same. */
function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const p of parts) {
    if (!p.text) continue;
    const last = out.at(-1);
    if (last && last.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}
