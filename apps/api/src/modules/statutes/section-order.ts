/**
 * Natural order of normalized section keys: 1 < 2 < 10 < 120 < 120A < 120B < 121 < 171I.
 * `statute_sections` has no position column, so this is how an Act's sections are listed. It also
 * fixes the portal's occasional out-of-order rows (CrPC prints 265I after 265K).
 */
export function compareSectionKeys(a: string, b: string): number {
  const pa = /^(\d+)([A-Z]*)$/.exec(a);
  const pb = /^(\d+)([A-Z]*)$/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  const na = Number(pa[1]);
  const nb = Number(pb[1]);
  if (na !== nb) return na - nb;
  const sa = pa[2]!;
  const sb = pb[2]!;
  if (sa.length !== sb.length) return sa.length - sb.length; // 120 < 120A < 120AA
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export interface ChapterGroup<T> {
  chapter: string | null;
  sections: T[];
}

/** Groups consecutive sections (already in order) by chapter reference. */
export function groupByChapter<T extends { chapterReference: string | null }>(sections: T[]): ChapterGroup<T>[] {
  const groups: ChapterGroup<T>[] = [];
  for (const s of sections) {
    const last = groups.at(-1);
    if (last && last.chapter === s.chapterReference) last.sections.push(s);
    else groups.push({ chapter: s.chapterReference, sections: [s] });
  }
  return groups;
}
