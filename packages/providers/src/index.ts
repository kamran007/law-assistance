export { TeiEmbeddingProvider, EmbeddingError, type EmbeddingProvider, type EmbedFetch, type TeiEmbeddingOptions } from './embedding';
export {
  QdrantChunkIndex,
  createChunkCollection,
  createQdrantClient,
  resolveAlias,
  swapAlias,
  buildFilter,
  toPayloadDate,
  OPEN_ENDED_VALID_TO,
  CHUNK_COLLECTION_PARAMS,
  type ChunkIndex,
  type ChunkPayload,
  type ChunkPoint,
  type ChunkHit,
  type SearchFilter,
  type TemporalFilter,
} from './chunk-index';
export type { QdrantClient } from '@qdrant/js-client-rest';
export { STATUTE_CACHE_PREFIX, statuteGenerationKey } from './cache-keys';
