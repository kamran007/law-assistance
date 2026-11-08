import type { QdrantClient } from '@qdrant/js-client-rest';
import { CHUNK_COLLECTION_PARAMS } from './chunk-index';

/**
 * Vector index for judgment chunks (TRD §4.4, §6A.4; JUD-06): the Qdrant collection
 * `judgment_chunks`, behind an alias like `section_chunks`. MySQL (`judgment_chunks`) is the source
 * of truth; every write here is idempotent so outbox replays converge. Judgments are not versioned,
 * so there are no temporal filters.
 */
export interface JudgmentChunkPayload {
  judgment_id: string;
  division: 'AD' | 'HCD';
  issue_year: number;
  /** RFC 3339 datetime, or null when the decision date is unknown. */
  decision_date: string | null;
  /** Validated `statute_id:section_key` pairs (`judgments.normalized_section_keys`). */
  section_keys: string[];
  statute_ids: string[];
  lang: 'bn' | 'en' | 'mixed';
  paragraph_from: number | null;
  paragraph_to: number | null;
}

export interface JudgmentChunkPoint {
  id: string;
  vector: number[];
  payload: JudgmentChunkPayload;
}

export interface JudgmentSearchFilter {
  division?: 'AD' | 'HCD';
  statuteIds?: string[];
  sectionKeys?: string[];
  issueYearFrom?: number;
  issueYearTo?: number;
}

export interface JudgmentChunkHit {
  id: string;
  score: number;
  payload: JudgmentChunkPayload;
}

export interface JudgmentChunkIndex {
  upsert(points: readonly JudgmentChunkPoint[]): Promise<void>;
  /** Sets judgment-level payload fields on all its chunks (links changed, metadata corrected). */
  updateJudgment(judgmentId: string, patch: Partial<Omit<JudgmentChunkPayload, 'paragraph_from' | 'paragraph_to'>>): Promise<void>;
  /** Removes a judgment's chunks whose ids are not in `keepIds` (empty = remove all). */
  deleteJudgmentChunksExcept(judgmentId: string, keepIds: readonly string[]): Promise<void>;
  search(vector: number[], filter: JudgmentSearchFilter, limit: number): Promise<JudgmentChunkHit[]>;
  count(filter?: { judgmentId?: string }): Promise<number>;
}

type Condition = Record<string, unknown>;

export function buildJudgmentFilter(f: JudgmentSearchFilter): { must: Condition[] } {
  const must: Condition[] = [];
  if (f.division) must.push({ key: 'division', match: { value: f.division } });
  if (f.statuteIds?.length) must.push({ key: 'statute_ids', match: { any: f.statuteIds } });
  if (f.sectionKeys?.length) must.push({ key: 'section_keys', match: { any: f.sectionKeys } });
  if (f.issueYearFrom !== undefined || f.issueYearTo !== undefined) {
    must.push({ key: 'issue_year', range: { ...(f.issueYearFrom !== undefined ? { gte: f.issueYearFrom } : {}), ...(f.issueYearTo !== undefined ? { lte: f.issueYearTo } : {}) } });
  }
  return { must };
}

const byJudgment = (judgmentId: string) => ({ must: [{ key: 'judgment_id', match: { value: judgmentId } }] });

export class QdrantJudgmentIndex implements JudgmentChunkIndex {
  /** `collection` is usually the alias (`judgment_chunks`). */
  constructor(
    private readonly client: QdrantClient,
    private readonly collection: string,
  ) {}

  async upsert(points: readonly JudgmentChunkPoint[]): Promise<void> {
    if (!points.length) return;
    await this.client.upsert(this.collection, { wait: true, points: points.map((p) => ({ id: p.id, vector: p.vector, payload: { ...p.payload } })) });
  }

  async updateJudgment(judgmentId: string, patch: Partial<JudgmentChunkPayload>): Promise<void> {
    await this.client.setPayload(this.collection, { wait: true, payload: { ...patch }, filter: byJudgment(judgmentId) });
  }

  async deleteJudgmentChunksExcept(judgmentId: string, keepIds: readonly string[]): Promise<void> {
    await this.client.delete(this.collection, {
      wait: true,
      filter: { ...byJudgment(judgmentId), ...(keepIds.length ? { must_not: [{ has_id: [...keepIds] }] } : {}) },
    });
  }

  async search(vector: number[], filter: JudgmentSearchFilter, limit: number): Promise<JudgmentChunkHit[]> {
    const res = await this.client.query(this.collection, { query: vector, filter: buildJudgmentFilter(filter) as never, limit, with_payload: true });
    return res.points.map((p) => ({ id: String(p.id), score: p.score, payload: p.payload as unknown as JudgmentChunkPayload }));
  }

  async count(filter: { judgmentId?: string } = {}): Promise<number> {
    const res = await this.client.count(this.collection, { exact: true, ...(filter.judgmentId ? { filter: byJudgment(filter.judgmentId) } : {}) });
    return res.count;
  }
}

const JUDGMENT_PAYLOAD_INDEXES: ReadonlyArray<[string, 'integer' | 'keyword']> = [
  ['judgment_id', 'keyword'],
  ['division', 'keyword'],
  ['issue_year', 'integer'],
  ['statute_ids', 'keyword'],
  ['section_keys', 'keyword'],
];

/** Creates a physical judgment collection with the TRD vector params and payload indexes. Idempotent. */
export async function createJudgmentCollection(client: QdrantClient, name: string, dimensions: number): Promise<void> {
  if (!(await client.collectionExists(name)).exists) {
    await client.createCollection(name, {
      vectors: { size: dimensions, distance: CHUNK_COLLECTION_PARAMS.distance },
      hnsw_config: { ...CHUNK_COLLECTION_PARAMS.hnsw },
    });
  }
  for (const [field, schema] of JUDGMENT_PAYLOAD_INDEXES) {
    await client.createPayloadIndex(name, { field_name: field, field_schema: schema, wait: true });
  }
}
