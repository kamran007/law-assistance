import { auditLog, newId, scoped, type CaseArtifact, type Db } from '@lawassist/db';
import {
  FirCorrectionsSchema,
  TERMINAL_STATUSES,
  type ArtifactEvent,
  type ArtifactEventHub,
  type ArtifactEventPublisher,
  type ArtifactStatus,
} from '@lawassist/providers';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, type Authenticate } from '../../auth';
import { requireIfMatch, setVersionEtag } from '../../http';
import { ApiError } from '../../problem';
import { applyCorrections, isCorrectable } from './corrections';
import type { AnalysisQueue, ScanQueue } from './queue';
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
  /** `/reanalyze` (TRD §8.5). Without it the route answers 503. */
  analysis?: AnalysisQueue;
  /** Status relay for `/events` (TRD §8.1 step 4). Without it the route answers 503. */
  events?: ArtifactEventHub;
  /** Publishes the status change `/reanalyze` makes. */
  publisher?: ArtifactEventPublisher;
  /** SSE timings, shortened in tests. */
  sse?: { heartbeatMs?: number; maxStreamMs?: number };
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

/** Detail view: the list stays light; the scan result screen (App Flow §9.4) reads these. */
const artifactDetail = artifact.extend({
  structured_analysis: z.record(z.string(), z.unknown()).nullable(),
  role_analysis: z.record(z.string(), z.unknown()).nullable(),
});
const asRecord = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const toDetail = (a: CaseArtifact): z.infer<typeof artifactDetail> => ({
  ...toArtifact(a),
  structured_analysis: asRecord(a.structuredAnalysis),
  role_analysis: asRecord(a.roleAnalysis),
});

const toEvent = (a: CaseArtifact): ArtifactEvent => ({
  artifact_id: a.artifactId,
  status: (a.processingStatus ?? 'UPLOADED') as ArtifactStatus,
  error: a.processingStatus === 'FAILED' ? a.processingError : null,
  at: a.updatedAt.toISOString(),
});

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');
/** Download links for the original file are short-lived: the link itself grants access. */
export const ORIGINAL_URL_TTL_SECONDS = 5 * 60;
const busy = () => new ApiError(409, 'ARTIFACT_BUSY', 'The document is being processed', 'Wait until processing has finished (status READY)');

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
        schema: { tags: ['documents'], summary: 'A document’s processing status, extracted details and analysis', params: artifactParams, response: { 200: artifactDetail } },
      },
      async (req, reply) => {
        const { repo } = await auth(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        // The artifact must belong to THIS case too, not just to this user.
        if (!a || a.caseFileId !== req.params.id) throw notFound();
        setVersionEtag(reply, a.version);
        return toDetail(a);
      },
    );

    app.get(
      '/cases/:id/artifacts/:art_id/original',
      {
        config: { access: 'tenant', rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: {
          tags: ['documents'],
          summary: 'Short-lived link to the original uploaded file ("View original scan")',
          params: artifactParams,
          response: { 200: z.object({ url: z.string(), expires_in: z.number().int(), mime_type: z.string() }) },
        },
      },
      async (req, reply) => {
        const { repo } = await auth(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        if (!a || a.caseFileId !== req.params.id || !a.fileStorageKey) throw notFound();
        const mime = a.mimeType ?? 'application/octet-stream';
        const ext = a.fileStorageKey.split('.').pop() ?? 'bin';
        // PDFs and images open in the browser; a DOCX can only be downloaded.
        const disposition = mime === 'application/pdf' || mime.startsWith('image/') ? 'inline' : 'attachment';
        const url = await deps.storage.presignGet(a.fileStorageKey, { ttlSeconds: ORIGINAL_URL_TTL_SECONDS, contentType: mime, disposition, filename: `original.${ext}` });
        reply.header('cache-control', 'no-store');
        return { url, expires_in: ORIGINAL_URL_TTL_SECONDS, mime_type: mime };
      },
    );

    app.patch(
      '/cases/:id/artifacts/:art_id',
      {
        config: { access: 'tenant', rateLimit: { max: 120, timeWindow: '1 hour' } },
        schema: {
          tags: ['documents'],
          summary: 'Correct extracted FIR fields (needs If-Match). Dates and sections take effect after /reanalyze',
          params: artifactParams,
          body: FirCorrectionsSchema,
          response: { 200: artifactDetail },
        },
      },
      async (req, reply) => {
        const { p, repo } = await auth(req);
        const expected = requireIfMatch(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        if (!a || a.caseFileId !== req.params.id) throw notFound();
        if (a.processingStatus !== 'READY') throw busy();
        if (!isCorrectable(a.structuredAnalysis)) {
          throw new ApiError(409, 'NOT_CORRECTABLE', 'This document has no extracted FIR fields to correct');
        }
        const { analysis, changed } = applyCorrections(a.structuredAnalysis, req.body, new Date());
        const res = await repo.artifacts.updateAnalysis(a.artifactId, expected, analysis);
        if (res.status === 'not_found') throw notFound();
        if (res.status === 'busy') throw busy();
        if (res.status === 'version_conflict') {
          setVersionEtag(reply, res.current.version);
          throw new ApiError(412, 'VERSION_CONFLICT', 'The document was changed elsewhere', 'Reload it and apply your correction again');
        }
        // Who changed which fields; the values live in the artifact, not in the audit trail.
        await deps.db.insert(auditLog).values({ actorUserId: p.userId, action: 'ARTIFACT_FIELDS_CORRECTED', entity: 'case_artifact', entityId: a.artifactId, details: { fields: changed } });
        setVersionEtag(reply, res.row.version);
        return toDetail(res.row);
      },
    );

    app.post(
      '/cases/:id/artifacts/:art_id/reanalyze',
      {
        config: { access: 'tenant', rateLimit: { max: 30, timeWindow: '1 hour' } },
        schema: {
          tags: ['documents'],
          summary: 'Re-run dates, sections, Schedule II and the role analysis with the corrected fields',
          params: artifactParams,
          response: { 202: artifact },
        },
      },
      async (req, reply) => {
        const { p, repo } = await auth(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        if (!a || a.caseFileId !== req.params.id) throw notFound(); // ownership before anything else
        if (!deps.analysis) throw new ApiError(503, 'UNAVAILABLE', 'Reanalysis is not available');
        if (!isCorrectable(a.structuredAnalysis)) throw new ApiError(409, 'NOT_CORRECTABLE', 'This document has no FIR analysis to re-run');
        const started = await repo.artifacts.startReanalysis(a.artifactId);
        if (!started) throw busy();
        await deps.analysis.enqueueReanalysis({ artifactId: a.artifactId, ownerUserId: p.userId });
        await deps.publisher?.publish(toEvent(started)).catch((err: unknown) => req.log.warn({ artifactId: a.artifactId, err: String(err) }, 'status event not published'));
        req.log.info({ artifactId: a.artifactId }, 'reanalysis queued');
        return reply.status(202).send(toArtifact(started));
      },
    );

    app.get(
      '/cases/:id/artifacts/:art_id/events',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['documents'],
          summary: 'Live processing status (Server-Sent Events: `event: status`, data = {artifact_id, status, error, at}); ends at READY or FAILED',
          params: artifactParams,
        },
      },
      async (req, reply) => {
        const { repo } = await auth(req);
        const first = await repo.artifacts.findById(req.params.art_id);
        if (!first || first.caseFileId !== req.params.id) throw notFound(); // ownership before anything else
        if (!deps.events) throw new ApiError(503, 'UNAVAILABLE', 'Live status is not available', 'Poll GET …/artifacts/{id} instead');
        const artifactId = first.artifactId;

        // EventSource reconnects whenever a stream ends; 204 tells it to stop once processing has
        // finished (it sends Last-Event-ID on reconnects).
        if (req.headers['last-event-id'] && TERMINAL_STATUSES.includes(toEvent(first).status)) return reply.status(204).send();

        const raw = reply.raw;
        let closed = false;
        let lastSent = '';
        let seq = 0;
        // Set once the stream is running; `finish` may run before any of them exists.
        const handles: { heartbeat?: NodeJS.Timeout; maxTimer?: NodeJS.Timeout; unsubscribe?: () => Promise<void> } = {};

        const finish = () => {
          if (closed) return;
          closed = true;
          clearInterval(handles.heartbeat);
          clearTimeout(handles.maxTimer);
          void handles.unsubscribe?.().catch(() => undefined);
          raw.end();
        };
        const send = (ev: ArtifactEvent) => {
          if (closed) return;
          const key = `${ev.status}|${ev.error ?? ''}`;
          if (key === lastSent) return; // the initial read and an event can report the same change
          lastSent = key;
          raw.write(`id: ${++seq}\nevent: status\ndata: ${JSON.stringify(ev)}\n\n`);
          if (TERMINAL_STATUSES.includes(ev.status)) finish();
        };

        reply.hijack();
        raw.writeHead(200, {
          ...(reply.getHeaders() as Record<string, string>),
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        req.raw.on('close', finish);

        // Subscribe BEFORE reading the current state, so a change between the two is not lost.
        const buffered: ArtifactEvent[] = [];
        let live = false;
        handles.unsubscribe = await deps.events.subscribe(artifactId, (ev) => (live ? send(ev) : buffered.push(ev)));
        const current = await repo.artifacts.findById(artifactId);
        if (!current) return finish(); // deleted meanwhile
        send(toEvent(current));
        live = true;
        for (const ev of buffered) send(ev);

        handles.heartbeat = setInterval(() => !closed && raw.write(': keep-alive\n\n'), deps.sse?.heartbeatMs ?? 15_000);
        // Bounded streams; clients reconnect (and get 204 once processing has finished).
        handles.maxTimer = setTimeout(finish, deps.sse?.maxStreamMs ?? 10 * 60_000);
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
