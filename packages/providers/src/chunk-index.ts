import { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Vector index for statute chunks (TRD §4.4). Qdrant is a DERIVED index: MySQL is the source of
 * truth, and callers re-read text by chunk id. Every write is idempotent (upsert by id, payload
 * set by filter), so outbox replays converge on the MySQL state.
 */
export const OPEN_ENDED_VALID_TO = '9999-12-31T00:00:00Z';

export interface ChunkPayload {
  section_id: string;
  statute_id: string;
  act_status: 'ACTIVE' | 'REPEALED';
  is_current: boolean;
  /** RFC 3339 datetimes; open-ended `valid_to` = OPEN_ENDED_VALID_TO (no NULL handling in filters). */
  valid_from: string;
  valid_to: string;
  lang: 'bn' | 'en';
}

export interface ChunkPoint {
  id: string;
  vector: number[];
  payload: ChunkPayload;
}

/** `current`: in force now; `asOf`: the version valid on that date (point-in-time, FR-A3). */
export type TemporalFilter = { kind: 'current' } | { kind: 'asOf'; date: string };

export interface SearchFilter {
  temporal: TemporalFilter;
  statuteIds?: string[];
  /** Current-law answers exclude repealed Acts (TRD §6.3); historical queries may include them. */
  includeRepealed?: boolean;
}

export interface ChunkHit {
  id: string;
  score: number;
  payload: ChunkPayload;
}

export interface ChunkIndex {
  upsert(points: readonly ChunkPoint[]): Promise<void>;
  /** Sets payload fields on every chunk of a section (e.g. a version was closed). */
  updateSection(sectionId: string, patch: Partial<ChunkPayload>): Promise<void>;
  /** Sets payload fields on every chunk of a statute (e.g. it was repealed). */
  updateStatute(statuteId: string, patch: Pick<ChunkPayload, 'act_status'>): Promise<void>;
  /** Removes a section's chunks whose ids are not in `keepIds` (re-chunking produced fewer). */
  deleteSectionChunksExcept(sectionId: string, keepIds: readonly string[]): Promise<void>;
  search(vector: number[], filter: SearchFilter, limit: number): Promise<ChunkHit[]>;
  count(filter?: { sectionId?: string }): Promise<number>;
}

/** Converts a MySQL DATE ("2025-03-01") or null to the payload datetime form. */
export function toPayloadDate(date: string | null): string {
  return date ? `${date}T00:00:00Z` : OPEN_ENDED_VALID_TO;
}

type Condition = Record<string, unknown>;

export function buildFilter(f: SearchFilter): { must: Condition[] } {
  const must: Condition[] = [];
  if (f.temporal.kind === 'current') {
    must.push({ key: 'is_current', match: { value: true } });
  } else {
    // A version is valid on [valid_from, valid_to).
    const at = toPayloadDate(f.temporal.date);
    must.push({ key: 'valid_from', range: { lte: at } }, { key: 'valid_to', range: { gt: at } });
  }
  if (!f.includeRepealed) must.push({ key: 'act_status', match: { value: 'ACTIVE' } });
  if (f.statuteIds?.length) must.push({ key: 'statute_id', match: { any: f.statuteIds } });
  return { must };
}

export class QdrantChunkIndex implements ChunkIndex {
  /** `collection` is usually the alias (`section_chunks`), so reindexing can swap it. */
  constructor(
    private readonly client: QdrantClient,
    private readonly collection: string,
  ) {}

  async upsert(points: readonly ChunkPoint[]): Promise<void> {
    if (!points.length) return;
    await this.client.upsert(this.collection, {
      wait: true, // the outbox marks processed_at only after Qdrant confirms (TRD §4.4)
      points: points.map((p) => ({ id: p.id, vector: p.vector, payload: { ...p.payload } })),
    });
  }

  async updateSection(sectionId: string, patch: Partial<ChunkPayload>): Promise<void> {
    await this.client.setPayload(this.collection, {
      wait: true,
      payload: { ...patch },
      filter: { must: [{ key: 'section_id', match: { value: sectionId } }] },
    });
  }

  async updateStatute(statuteId: string, patch: Pick<ChunkPayload, 'act_status'>): Promise<void> {
    await this.client.setPayload(this.collection, {
      wait: true,
      payload: { ...patch },
      filter: { must: [{ key: 'statute_id', match: { value: statuteId } }] },
    });
  }

  async deleteSectionChunksExcept(sectionId: string, keepIds: readonly string[]): Promise<void> {
    await this.client.delete(this.collection, {
      wait: true,
      filter: {
        must: [{ key: 'section_id', match: { value: sectionId } }],
        ...(keepIds.length ? { must_not: [{ has_id: [...keepIds] }] } : {}),
      },
    });
  }

  async search(vector: number[], filter: SearchFilter, limit: number): Promise<ChunkHit[]> {
    const res = await this.client.query(this.collection, {
      query: vector,
      filter: buildFilter(filter) as never,
      limit,
      with_payload: true,
    });
    return res.points.map((p) => ({ id: String(p.id), score: p.score, payload: p.payload as unknown as ChunkPayload }));
  }

  async count(filter: { sectionId?: string } = {}): Promise<number> {
    const res = await this.client.count(this.collection, {
      exact: true,
      ...(filter.sectionId ? { filter: { must: [{ key: 'section_id', match: { value: filter.sectionId } }] } } : {}),
    });
    return res.count;
  }
}

/** Collection parameters from TRD §4.4. */
export const CHUNK_COLLECTION_PARAMS = { distance: 'Cosine', hnsw: { m: 16, ef_construct: 128 } } as const;

const PAYLOAD_INDEXES: ReadonlyArray<[string, 'bool' | 'datetime' | 'keyword']> = [
  ['is_current', 'bool'],
  ['valid_from', 'datetime'],
  ['valid_to', 'datetime'],
  ['statute_id', 'keyword'],
  ['section_id', 'keyword'],
  ['act_status', 'keyword'],
];

/** Creates a physical collection with the TRD vector params and payload indexes. Idempotent. */
export async function createChunkCollection(client: QdrantClient, name: string, dimensions: number): Promise<void> {
  if (!(await client.collectionExists(name)).exists) {
    await client.createCollection(name, {
      vectors: { size: dimensions, distance: CHUNK_COLLECTION_PARAMS.distance },
      hnsw_config: { ...CHUNK_COLLECTION_PARAMS.hnsw },
    });
  }
  for (const [field, schema] of PAYLOAD_INDEXES) {
    await client.createPayloadIndex(name, { field_name: field, field_schema: schema, wait: true });
  }
}

/** The physical collection an alias points to, or null. */
export async function resolveAlias(client: QdrantClient, alias: string): Promise<string | null> {
  const { aliases } = await client.getAliases();
  return aliases.find((a) => a.alias_name === alias)?.collection_name ?? null;
}

/** Atomically repoints `alias` at `collection` (zero-downtime reindex, TRD §4.4). */
export async function swapAlias(client: QdrantClient, alias: string, collection: string): Promise<string | null> {
  const previous = await resolveAlias(client, alias);
  await client.updateCollectionAliases({
    actions: [
      ...(previous ? [{ delete_alias: { alias_name: alias } }] : []),
      { create_alias: { collection_name: collection, alias_name: alias } },
    ],
  });
  return previous;
}

export function createQdrantClient(opts: { url: string; apiKey?: string | undefined }): QdrantClient {
  return new QdrantClient({ url: opts.url, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), checkCompatibility: false });
}
