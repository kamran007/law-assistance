import { newId, scoped, type CaseArtifact, type Db } from '@lawassist/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, type Authenticate } from '../../auth';
import { ApiError } from '../../problem';
import type { ScanQueue } from './queue';
import type { DocumentStorage } from './storage';
import {
  MAGIC_BYTES_TO_READ,
  MAX_UPLOAD_BYTES,
  SCANNABLE_TYPES,
  UPLOAD_CONTENT_TYPES,
  UPLOAD_URL_TTL_SECONDS,
  magicBytesMatch,
  parseOwnUploadKey,
  uploadKey,
} from './upload-policy';

export interface DocumentRoutesDeps {
  db: Db;
  authenticate: Authenticate;
  storage: DocumentStorage;
  queue: ScanQueue;
}

const caseParam = z.object({ id: z.uuid() });
const artifactParams = caseParam.extend({ art_id: z.uuid() });

const artifact = z.object({
  artifact_id: z.string(),
  case_id: z.string(),
  artifact_type: z.string(),
  processing_status: z.enum(['UPLOADED', 'OCR', 'EXTRACTING', 'SCHEDULE_LOOKUP', 'ANALYZING', 'READY', 'FAILED']).nullable(),
  processing_error: z.string().nullable(),
  mime_type: z.string().nullable(),
  page_count: z.number().int().nullable(),
  ocr_confidence: z.number().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

const toArtifact = (a: CaseArtifact): z.infer<typeof artifact> => ({
  artifact_id: a.artifactId,
  case_id: a.caseFileId,
  artifact_type: a.artifactType,
  processing_status: a.processingStatus,
  processing_error: a.processingError,
  mime_type: a.mimeType,
  page_count: a.pageCount,
  ocr_confidence: a.ocrConfidence,
  version: a.version,
  created_at: a.createdAt.toISOString(),
  updated_at: a.updatedAt.toISOString(),
});

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

/**
 * Document upload and registration (TRD §8.1, §12.6; BE-21) plus artifact reads. The file never
 * passes through the API: the client PUTs it straight to S3 with a presigned URL, then registers it.
 */
export const documentRoutes =
  (deps: DocumentRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const auth = async (req: Parameters<Authenticate>[0]) => {
      const p = requireAuth(await deps.authenticate(req));
      return { p, repo: scoped(deps.db, p.userId) };
    };

    app.post(
      '/cases/:id/documents/upload-url',
      {
        config: { access: 'tenant', rateLimit: { max: 60, timeWindow: '1 hour' } },
        schema: {
          tags: ['documents'],
          summary: 'Get a presigned URL to upload a document (PDF, JPEG, PNG or DOCX, ≤ 25 MB)',
          params: caseParam,
          body: z.object({ content_type: z.enum(UPLOAD_CONTENT_TYPES), size_bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES) }).strict(),
          response: {
            200: z.object({
              artifact_id: z.string(),
              s3_key: z.string(),
              upload_url: z.string(),
              method: z.literal('PUT'),
              /** Send exactly these headers with the PUT; they are part of the signature. */
              headers: z.record(z.string(), z.string()),
              expires_in: z.number().int(),
            }),
          },
        },
      },
      async (req) => {
        const { p, repo } = await auth(req);
        if (!(await repo.caseFiles.findById(req.params.id))) throw notFound();
        const artifactId = newId();
        const key = uploadKey(p.userId, req.params.id, artifactId, req.body.content_type);
        const signed = await deps.storage.presignPut(key, req.body.content_type, req.body.size_bytes, UPLOAD_URL_TTL_SECONDS);
        return { artifact_id: artifactId, s3_key: key, upload_url: signed.url, method: 'PUT' as const, headers: signed.headers, expires_in: UPLOAD_URL_TTL_SECONDS };
      },
    );

    app.post(
      '/cases/:id/documents/scan',
      {
        // TRD §5.5: 30 scans per hour.
        config: { access: 'tenant', rateLimit: { max: 30, timeWindow: '1 hour' } },
        schema: {
          tags: ['documents'],
          summary: 'Register an uploaded document and start the scan pipeline',
          params: caseParam,
          body: z.object({ s3_key: z.string().max(300), artifact_type: z.enum(SCANNABLE_TYPES), page_count: z.number().int().min(1).max(200).optional() }).strict(),
          response: { 202: artifact },
        },
      },
      async (req, reply) => {
        const { p, repo } = await auth(req);
        if (!(await repo.caseFiles.findById(req.params.id))) throw notFound();
        const parsed = parseOwnUploadKey(req.body.s3_key, p.userId, req.params.id);
        if (!parsed) throw new ApiError(422, 'INVALID_UPLOAD_KEY', 'Unknown upload', 'Use the s3_key returned by upload-url');

        // A retry after a successful registration: same answer, no second pipeline.
        const existing = await repo.artifacts.findById(parsed.artifactId);
        if (existing) {
          if (existing.caseFileId !== req.params.id) throw notFound();
          return reply.status(202).send(toArtifact(existing));
        }

        const head = await deps.storage.head(req.body.s3_key);
        if (!head) throw new ApiError(422, 'UPLOAD_NOT_FOUND', 'The file has not been uploaded yet', 'Upload it with the presigned URL first');
        if (head.sizeBytes > MAX_UPLOAD_BYTES) throw new ApiError(422, 'UPLOAD_TOO_LARGE', 'The file is larger than 25 MB');
        if (head.contentType !== parsed.contentType) throw new ApiError(422, 'UPLOAD_TYPE_MISMATCH', 'The file type does not match the upload');
        // Never trust the declared type: check the file's own signature (TRD §12.6).
        const start = await deps.storage.readStart(req.body.s3_key, MAGIC_BYTES_TO_READ);
        if (!(await magicBytesMatch(start, parsed.contentType))) {
          throw new ApiError(422, 'UPLOAD_CONTENT_INVALID', 'The file is not a valid PDF, JPEG, PNG or DOCX');
        }

        const created = await repo.artifacts.createUpload({
          artifactId: parsed.artifactId,
          caseFileId: req.params.id,
          artifactType: req.body.artifact_type,
          fileStorageKey: req.body.s3_key,
          mimeType: parsed.contentType,
          pageCount: req.body.page_count ?? null,
        });
        if (!created) throw notFound();
        // Job id = artifact id, so this is safe to repeat after a crash between insert and enqueue.
        await deps.queue.enqueue({ artifactId: created.row.artifactId, ownerUserId: p.userId });
        req.log.info({ artifactId: created.row.artifactId, type: req.body.artifact_type, sizeBytes: head.sizeBytes }, 'document registered');
        return reply.status(202).send(toArtifact(created.row));
      },
    );

    app.get(
      '/cases/:id/artifacts',
      {
        config: { access: 'tenant' },
        schema: { tags: ['documents'], summary: 'Documents and drafts in a case', params: caseParam, response: { 200: z.object({ items: z.array(artifact) }) } },
      },
      async (req) => {
        const { repo } = await auth(req);
        const rows = await repo.artifacts.listByCase(req.params.id);
        if (!rows) throw notFound();
        return { items: rows.map(toArtifact) };
      },
    );

    app.get(
      '/cases/:id/artifacts/:art_id',
      {
        config: { access: 'tenant' },
        schema: { tags: ['documents'], summary: 'A document’s processing status and details', params: artifactParams, response: { 200: artifact } },
      },
      async (req) => {
        const { repo } = await auth(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        // The artifact must belong to THIS case too, not just to this user.
        if (!a || a.caseFileId !== req.params.id) throw notFound();
        return toArtifact(a);
      },
    );

    app.delete(
      '/cases/:id/artifacts/:art_id',
      {
        config: { access: 'tenant' },
        schema: { tags: ['documents'], summary: 'Delete a document', params: artifactParams, response: { 204: z.null() } },
      },
      async (req, reply) => {
        const { repo } = await auth(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        if (!a || a.caseFileId !== req.params.id) throw notFound();
        if (!(await repo.artifacts.softDelete(a.artifactId))) throw notFound();
        return reply.status(204).send(null);
      },
    );
  };
