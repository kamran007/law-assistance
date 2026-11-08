import { asc, eq, gt, inArray } from 'drizzle-orm';
import { judgmentChunks, judgments, type Db } from '@lawassist/db';
import type { EmbeddingProvider, JudgmentChunkIndex, JudgmentChunkPayload } from '@lawassist/providers';
import type { ChunkOptions } from './chunker';
import { chunkJudgment, judgmentChunkId, type JudgmentChunk } from './judgment-chunker';

/**
 * Keeps `judgment_chunks` (MySQL) and the Qdrant collection `judgment_chunks` in step with
 * `judgments` (TRD §6A.4; JUD-06). Everything is re-read from MySQL, never taken from event
 * payloads, so replays and reordering converge. Only judgments with usable text are indexed
 * (`OK` / `OCR_USED`); a NEEDS_REVIEW judgment has its chunks removed until it is fixed.
 */
export interface JudgmentIndexerDeps {
  db: Db;
  embedder: EmbeddingProvider;
  index: JudgmentChunkIndex;
  chunkOptions?: ChunkOptions;
}

export interface JudgmentIndexStats {
  judgments: number;
  embedded: number;
  /** Chunks and model unchanged: payload refreshed only (e.g. statute links changed). */
  payloadOnly: number;
  /** Not indexable (no usable text) or gone: chunks removed. */
  removed: number;
}

type Row = {
  judgmentId: string;
  parties: string;
  citation: string;
  division: 'AD' | 'HCD';
  issueYear: number;
  decisionDate: string | null;
  language: 'EN' | 'BN' | 'MIXED';
  fullText: string | null;
  keyRatioParagraphs: string[];
  normalizedSectionKeys: string[];
  extractionStatus: 'OK' | 'OCR_USED' | 'NEEDS_REVIEW';
};

export function judgmentPayload(row: Row, chunk?: Pick<JudgmentChunk, 'paragraphFrom' | 'paragraphTo'>): JudgmentChunkPayload {
  const keys = [...row.normalizedSectionKeys].sort();
  return {
    judgment_id: row.judgmentId,
    division: row.division,
    issue_year: row.issueYear,
    decision_date: row.decisionDate ? `${row.decisionDate}T00:00:00Z` : null,
    section_keys: keys,
    statute_ids: [...new Set(keys.map((k) => k.split(':')[0]!))],
    lang: row.language === 'BN' ? 'bn' : row.language === 'MIXED' ? 'mixed' : 'en',
    paragraph_from: chunk?.paragraphFrom ?? null,
    paragraph_to: chunk?.paragraphTo ?? null,
  };
}

const indexable = (r: Row) => r.extractionStatus !== 'NEEDS_REVIEW' && !!r.fullText?.trim();

export class JudgmentIndexer {
  constructor(private readonly deps: JudgmentIndexerDeps) {}

  async indexJudgments(judgmentIds: readonly string[], opts: { force?: boolean } = {}): Promise<JudgmentIndexStats> {
    const stats: JudgmentIndexStats = { judgments: 0, embedded: 0, payloadOnly: 0, removed: 0 };
    const ids = [...new Set(judgmentIds)];
    if (!ids.length) return stats;
    const rows = await this.load(ids);
    const found = new Set(rows.map((r) => r.judgmentId));
    for (const id of ids.filter((i) => !found.has(i))) {
      await this.remove(id);
      stats.removed++;
    }

    const toEmbed: { row: Row; chunks: JudgmentChunk[] }[] = [];
    for (const row of rows) {
      stats.judgments++;
      if (!indexable(row)) {
        await this.remove(row.judgmentId);
        stats.removed++;
        continue;
      }
      const chunks = chunkJudgment(
        { parties: row.parties, citation: row.citation, division: row.division, fullText: row.fullText!, keyRatioParagraphs: row.keyRatioParagraphs },
        this.deps.chunkOptions,
      );
      if (!opts.force && (await this.isUpToDate(row.judgmentId, chunks))) {
        const payload: Partial<JudgmentChunkPayload> = judgmentPayload(row);
        delete payload.paragraph_from; // per chunk, unchanged
        delete payload.paragraph_to;
        await this.deps.index.updateJudgment(row.judgmentId, payload);
        stats.payloadOnly++;
      } else toEmbed.push({ row, chunks });
    }
    if (!toEmbed.length) return stats;

    const vectors = await this.deps.embedder.embed(toEmbed.flatMap((j) => j.chunks.map((c) => c.text)));
    let offset = 0;
    for (const { row, chunks } of toEmbed) {
      const ids = chunks.map((_, i) => judgmentChunkId(row.judgmentId, i));
      await this.writeChunkRows(row.judgmentId, chunks, ids);
      await this.deps.index.upsert(chunks.map((c, i) => ({ id: ids[i]!, vector: vectors[offset + i]!, payload: judgmentPayload(row, c) })));
      await this.deps.index.deleteJudgmentChunksExcept(row.judgmentId, ids);
      await this.deps.db.update(judgmentChunks).set({ indexedAt: new Date(), embeddingModel: this.deps.embedder.model }).where(eq(judgmentChunks.judgmentId, row.judgmentId));
      offset += chunks.length;
      stats.embedded++;
    }
    return stats;
  }

  /** Drops a judgment from the index and its chunk rows (JUDGMENT_REMOVED, or no usable text). */
  async remove(judgmentId: string): Promise<void> {
    await this.deps.index.deleteJudgmentChunksExcept(judgmentId, []);
    await this.deps.db.delete(judgmentChunks).where(eq(judgmentChunks.judgmentId, judgmentId));
  }

  async *allJudgmentIds(pageSize = 100): AsyncGenerator<string[]> {
    let after: string | null = null;
    for (;;) {
      const page: { id: string }[] = await this.deps.db
        .select({ id: judgments.judgmentId })
        .from(judgments)
        .where(after ? gt(judgments.judgmentId, after) : undefined)
        .orderBy(asc(judgments.judgmentId))
        .limit(pageSize);
      if (!page.length) return;
      yield page.map((r) => r.id);
      after = page.at(-1)!.id;
    }
  }

  private load(ids: readonly string[]): Promise<Row[]> {
    return this.deps.db
      .select({
        judgmentId: judgments.judgmentId,
        parties: judgments.parties,
        citation: judgments.citation,
        division: judgments.division,
        issueYear: judgments.issueYear,
        decisionDate: judgments.decisionDate,
        language: judgments.language,
        fullText: judgments.fullText,
        keyRatioParagraphs: judgments.keyRatioParagraphs,
        normalizedSectionKeys: judgments.normalizedSectionKeys,
        extractionStatus: judgments.extractionStatus,
      })
      .from(judgments)
      .where(inArray(judgments.judgmentId, [...ids]));
  }

  private async isUpToDate(judgmentId: string, chunks: readonly JudgmentChunk[]): Promise<boolean> {
    const existing = await this.deps.db
      .select({ idx: judgmentChunks.chunkIndex, text: judgmentChunks.chunkText, model: judgmentChunks.embeddingModel, indexedAt: judgmentChunks.indexedAt })
      .from(judgmentChunks)
      .where(eq(judgmentChunks.judgmentId, judgmentId))
      .orderBy(asc(judgmentChunks.chunkIndex));
    return existing.length === chunks.length && existing.every((c, i) => c.idx === i && c.text === chunks[i]!.text && c.model === this.deps.embedder.model && c.indexedAt !== null);
  }

  private async writeChunkRows(judgmentId: string, chunks: readonly JudgmentChunk[], ids: readonly string[]): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await tx.delete(judgmentChunks).where(eq(judgmentChunks.judgmentId, judgmentId));
      await tx.insert(judgmentChunks).values(
        chunks.map((c, i) => ({ chunkId: ids[i]!, judgmentId, chunkIndex: i, paragraphFrom: c.paragraphFrom, paragraphTo: c.paragraphTo, chunkText: c.text, embeddingModel: null, indexedAt: null })),
      );
    });
  }
}
