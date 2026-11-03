import { asc, eq, gt, inArray } from 'drizzle-orm';
import { sectionChunks, statutes, statuteSections, type Db } from '@lawassist/db';
import { toPayloadDate, type ChunkIndex, type ChunkPayload, type EmbeddingProvider } from '@lawassist/providers';
import { chunkId, chunkSection, type ChunkOptions } from './chunker';

/**
 * Keeps `section_chunks` (MySQL text) and Qdrant (vectors + payload) in step with
 * `statute_sections` (TRD §4.4, §6.4). Everything is derived from the current MySQL rows, never
 * from event payloads, so any replay or reordering of outbox events converges on the same state.
 */
export interface IndexerDeps {
  db: Db;
  embedder: EmbeddingProvider;
  index: ChunkIndex;
  chunkOptions?: ChunkOptions;
}

export interface IndexStats {
  sections: number;
  embedded: number;
  /** Sections whose chunks and model were unchanged: payload refreshed, no re-embedding. */
  payloadOnly: number;
  missing: number;
}

interface SectionRow {
  sectionId: string;
  statuteId: string;
  sectionNumber: string;
  marginalHeading: string | null;
  contentBody: string;
  isCurrent: boolean;
  validFrom: string;
  validTo: string | null;
  actStatus: 'ACTIVE' | 'REPEALED';
  language: 'BN' | 'EN';
  titleEn: string | null;
  titleBn: string | null;
}

export class SectionIndexer {
  constructor(private readonly deps: IndexerDeps) {}

  /**
   * (Re)indexes sections: chunk → write `section_chunks` → embed → Qdrant upsert → drop stale
   * points → set `indexed_at`. `force` re-embeds even if nothing changed (reindex into a new
   * collection, or a model upgrade).
   */
  async indexSections(sectionIds: readonly string[], opts: { force?: boolean } = {}): Promise<IndexStats> {
    const stats: IndexStats = { sections: 0, embedded: 0, payloadOnly: 0, missing: 0 };
    const ids = [...new Set(sectionIds)];
    if (!ids.length) return stats;
    const rows = await this.loadSections(ids);
    stats.missing = ids.length - rows.length;

    const toEmbed: { row: SectionRow; texts: string[] }[] = [];
    for (const row of rows) {
      stats.sections++;
      const texts = chunkSection(
        {
          actTitle: row.language === 'BN' ? (row.titleBn ?? row.titleEn) : (row.titleEn ?? row.titleBn),
          sectionNumber: row.sectionNumber,
          marginalHeading: row.marginalHeading,
          contentBody: row.contentBody,
        },
        this.deps.chunkOptions,
      );
      if (!opts.force && (await this.isUpToDate(row.sectionId, texts))) {
        await this.deps.index.updateSection(row.sectionId, payloadOf(row));
        stats.payloadOnly++;
      } else {
        toEmbed.push({ row, texts });
      }
    }
    if (!toEmbed.length) return stats;

    // One embedding call for all chunks of the batch (the provider splits into TEI batches of 64).
    const vectors = await this.deps.embedder.embed(toEmbed.flatMap((s) => s.texts));
    let offset = 0;
    for (const { row, texts } of toEmbed) {
      const ids = texts.map((_, i) => chunkId(row.sectionId, i));
      const payload = payloadOf(row);
      await this.writeChunkRows(row.sectionId, texts, ids);
      await this.deps.index.upsert(texts.map((_, i) => ({ id: ids[i]!, vector: vectors[offset + i]!, payload })));
      await this.deps.index.deleteSectionChunksExcept(row.sectionId, ids);
      await this.deps.db
        .update(sectionChunks)
        .set({ indexedAt: new Date(), embeddingModel: this.deps.embedder.model })
        .where(eq(sectionChunks.sectionId, row.sectionId));
      offset += texts.length;
      stats.embedded++;
    }
    return stats;
  }

  /** Payload-only refresh for one section (e.g. a version was closed). */
  async refreshSectionPayload(sectionId: string): Promise<boolean> {
    const [row] = await this.loadSections([sectionId]);
    if (!row) return false;
    await this.deps.index.updateSection(sectionId, payloadOf(row));
    return true;
  }

  /** Payload-only refresh for all chunks of a statute (status change, TRD §6.3). */
  async refreshStatutePayload(statuteId: string): Promise<boolean> {
    const [s] = await this.deps.db.select({ status: statutes.status }).from(statutes).where(eq(statutes.statuteId, statuteId));
    if (!s) return false;
    await this.deps.index.updateStatute(statuteId, { act_status: s.status });
    return true;
  }

  /** Every section id (all versions: point-in-time search needs closed versions too), paged. */
  async *allSectionIds(pageSize = 200): AsyncGenerator<string[]> {
    let after: string | null = null;
    for (;;) {
      const page: { id: string }[] = await this.deps.db
        .select({ id: statuteSections.sectionId })
        .from(statuteSections)
        .where(after ? gt(statuteSections.sectionId, after) : undefined)
        .orderBy(asc(statuteSections.sectionId))
        .limit(pageSize);
      if (!page.length) return;
      yield page.map((r) => r.id);
      after = page.at(-1)!.id;
    }
  }

  private async loadSections(ids: readonly string[]): Promise<SectionRow[]> {
    return this.deps.db
      .select({
        sectionId: statuteSections.sectionId,
        statuteId: statuteSections.statuteId,
        sectionNumber: statuteSections.sectionNumber,
        marginalHeading: statuteSections.marginalHeading,
        contentBody: statuteSections.contentBody,
        isCurrent: statuteSections.isCurrent,
        validFrom: statuteSections.validFrom,
        validTo: statuteSections.validTo,
        actStatus: statutes.status,
        language: statutes.language,
        titleEn: statutes.titleEn,
        titleBn: statutes.titleBn,
      })
      .from(statuteSections)
      .innerJoin(statutes, eq(statutes.statuteId, statuteSections.statuteId))
      .where(inArray(statuteSections.sectionId, [...ids]));
  }

  /** Same chunk texts, same model, all indexed → only the payload can be stale. */
  private async isUpToDate(sectionId: string, texts: readonly string[]): Promise<boolean> {
    const existing = await this.deps.db
      .select({ idx: sectionChunks.chunkIndex, text: sectionChunks.chunkText, model: sectionChunks.embeddingModel, indexedAt: sectionChunks.indexedAt })
      .from(sectionChunks)
      .where(eq(sectionChunks.sectionId, sectionId))
      .orderBy(asc(sectionChunks.chunkIndex));
    return (
      existing.length === texts.length &&
      existing.every((c, i) => c.idx === i && c.text === texts[i] && c.model === this.deps.embedder.model && c.indexedAt !== null)
    );
  }

  /** Replaces a section's chunk rows. Ids are deterministic, so this is safe to repeat. */
  private async writeChunkRows(sectionId: string, texts: readonly string[], ids: readonly string[]): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await tx.delete(sectionChunks).where(eq(sectionChunks.sectionId, sectionId));
      await tx.insert(sectionChunks).values(
        texts.map((chunkText, i) => ({ chunkId: ids[i]!, sectionId, chunkIndex: i, chunkText, embeddingModel: null, indexedAt: null })),
      );
    });
  }
}

export function payloadOf(row: Pick<SectionRow, 'sectionId' | 'statuteId' | 'actStatus' | 'isCurrent' | 'validFrom' | 'validTo' | 'language'>): ChunkPayload {
  return {
    section_id: row.sectionId,
    statute_id: row.statuteId,
    act_status: row.actStatus,
    is_current: row.isCurrent,
    valid_from: toPayloadDate(row.validFrom),
    valid_to: toPayloadDate(row.validTo),
    lang: row.language === 'BN' ? 'bn' : 'en',
  };
}
