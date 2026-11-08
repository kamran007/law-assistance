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
export { notConfiguredOcr, OcrNotConfiguredError, type OcrPageResult, type OcrProvider } from './ocr';
export { SCAN_QUEUE, SCAN_JOB, ANALYSIS_QUEUE, ANALYSIS_JOB, type DocumentJob } from './queues';
export {
  createLlmClient,
  CircuitBreaker,
  LlmNotConfiguredError,
  LlmUnavailableError,
  LlmRefusalError,
  LlmTruncatedError,
  type LlmClient,
  type LlmConfig,
  type LlmPurpose,
  type Effort,
  type StructuredRequest,
  type StructuredResult,
} from './llm';
