import { scoped, type CaseFile, type Db } from '@lawassist/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, type Authenticate, type Principal } from '../../auth';
import { requireIfMatch, setVersionEtag } from '../../http';
import { ApiError } from '../../problem';
import { conversationSummary, toConversationSummary } from '../conversations/schemas';

export interface CaseRoutesDeps {
  db: Db;
  authenticate: Authenticate;
  /** Today's date in Asia/Dhaka; an offense date can't be in the future. */
  today: () => string;
  now?: () => Date;
}

const isoDate = z.iso.date();
const caseFields = {
  title: z.string().trim().min(1).max(300).nullable(),
  case_number: z.string().trim().min(1).max(200).nullable(),
  court_or_thana: z.string().trim().min(1).max(200).nullable(),
  /** Drives point-in-time law in the case conversation (FR-A4, App Flow §5.2). */
  alleged_offense_date: isoDate.nullable(),
};

const caseFile = z.object({
  case_id: z.string(),
  title: z.string().nullable(),
  case_number: z.string().nullable(),
  court_or_thana: z.string().nullable(),
  alleged_offense_date: isoDate.nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Set only on tombstones in an `updated_since` sync. */
  deleted_at: z.string().nullable(),
});

const caseIdParam = z.object({ id: z.uuid() });

const toCase = (c: CaseFile): z.infer<typeof caseFile> => ({
  case_id: c.caseFileId,
  title: c.title,
  case_number: c.caseNumber,
  court_or_thana: c.courtOrThana,
  alleged_offense_date: c.allegedOffenseDate,
  version: c.version,
  created_at: c.createdAt.toISOString(),
  updated_at: c.updatedAt.toISOString(),
  deleted_at: c.deletedAt?.toISOString() ?? null,
});

/** Lawyers and Judges get exactly one conversation per case; Citizens never do (App Flow §5.2). */
const hasCaseConversations = (p: Principal) => p.role === 'LAWYER' || p.role === 'JUDGE';

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

/** Case files (TRD §5.1, §5.4; BE-15). Every query goes through `scoped()` (TRD §4.3). */
export const caseRoutes =
  (deps: CaseRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const now = deps.now ?? (() => new Date());
    const repoFor = async (req: Parameters<Authenticate>[0]) => {
      const p = requireAuth(await deps.authenticate(req));
      return { p, repo: scoped(deps.db, p.userId) };
    };
    const checkOffenseDate = (d: string | null | undefined) => {
      if (d && d > deps.today()) throw new ApiError(422, 'OFFENSE_DATE_IN_FUTURE', 'The offense date cannot be in the future');
    };

    app.get(
      '/cases',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['cases'],
          summary: 'My case files. With updated_since: changes since then, deleted ones as tombstones',
          querystring: z.object({ updated_since: z.iso.datetime({ offset: true }).optional() }),
          response: { 200: z.object({ items: z.array(caseFile), server_time: z.string() }) },
        },
      },
      async (req) => {
        const { repo } = await repoFor(req);
        // Read the clock before the query, so a change made during it shows up in the next sync.
        const serverTime = now().toISOString();
        const since = req.query.updated_since ? new Date(req.query.updated_since) : undefined;
        const rows = await repo.caseFiles.list(since ? { updatedSince: since } : {});
        return { items: rows.map(toCase), server_time: serverTime };
      },
    );

    app.post(
      '/cases',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['cases'],
          summary: 'Create a case file (Lawyers/Judges also get its conversation)',
          body: z.object(caseFields).partial().strict(),
          response: { 201: caseFile.extend({ conversation: conversationSummary.nullable() }) },
        },
      },
      async (req, reply) => {
        const { p, repo } = await repoFor(req);
        checkOffenseDate(req.body.alleged_offense_date);
        const created = await repo.caseFiles.create(
          {
            title: req.body.title ?? null,
            caseNumber: req.body.case_number ?? null,
            courtOrThana: req.body.court_or_thana ?? null,
            allegedOffenseDate: req.body.alleged_offense_date ?? null,
          },
          { withConversation: hasCaseConversations(p) },
        );
        const conversation = hasCaseConversations(p) ? await repo.conversations.findForCase(created.caseFileId) : null;
        setVersionEtag(reply, created.version);
        return reply.status(201).send({ ...toCase(created), conversation: conversation ? toConversationSummary(conversation) : null });
      },
    );

    app.get(
      '/cases/:id',
      { config: { access: 'tenant' }, schema: { tags: ['cases'], summary: 'Case file detail', params: caseIdParam, response: { 200: caseFile } } },
      async (req, reply) => {
        const { repo } = await repoFor(req);
        const c = await repo.caseFiles.findById(req.params.id);
        if (!c) throw notFound();
        setVersionEtag(reply, c.version);
        return toCase(c);
      },
    );

    app.patch(
      '/cases/:id',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['cases'],
          summary: 'Edit case details (needs If-Match; 409 with the current copy on a version conflict)',
          params: caseIdParam,
          body: z.object(caseFields).partial().strict(),
          response: {
            200: caseFile,
            409: z.object({ type: z.string(), title: z.string(), status: z.literal(409), code: z.string(), detail: z.string().optional(), current: caseFile }),
          },
        },
      },
      async (req, reply) => {
        const { repo } = await repoFor(req);
        const expected = requireIfMatch(req);
        checkOffenseDate(req.body.alleged_offense_date);
        const b = req.body;
        const res = await repo.caseFiles.update(req.params.id, expected, {
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.case_number !== undefined ? { caseNumber: b.case_number } : {}),
          ...(b.court_or_thana !== undefined ? { courtOrThana: b.court_or_thana } : {}),
          ...(b.alleged_offense_date !== undefined ? { allegedOffenseDate: b.alleged_offense_date } : {}),
        });
        if (res.status === 'not_found') throw notFound();
        if (res.status === 'version_conflict') {
          // TRD §5.4: metadata conflicts are 409; the client reloads and reapplies.
          setVersionEtag(reply, res.current.version);
          return reply.status(409).type('application/problem+json').send({
            ...new ApiError(409, 'VERSION_CONFLICT', 'This case was changed on another device', 'Reload and apply your change again').toProblem(),
            status: 409 as const,
            current: toCase(res.current),
          });
        }
        setVersionEtag(reply, res.row.version);
        return toCase(res.row);
      },
    );

    app.delete(
      '/cases/:id',
      {
        config: { access: 'tenant' },
        schema: { tags: ['cases'], summary: 'Delete a case file with its documents and conversation', params: caseIdParam, response: { 204: z.null() } },
      },
      async (req, reply) => {
        const { repo } = await repoFor(req);
        if (!(await repo.caseFiles.softDelete(req.params.id))) throw notFound();
        return reply.status(204).send(null);
      },
    );

    app.get(
      '/cases/:id/conversation',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['cases'],
          summary: 'The case’s single conversation (Lawyers/Judges; created if missing)',
          params: caseIdParam,
          response: { 200: conversationSummary },
        },
      },
      async (req) => {
        const { p, repo } = await repoFor(req);
        // Ownership first, so another user's case id is a 404 whatever the caller's role.
        if (!(await repo.caseFiles.findById(req.params.id))) throw notFound();
        if (!hasCaseConversations(p)) {
          throw new ApiError(403, 'ROLE_FORBIDDEN', 'Case conversations are for lawyers and judges', 'Use the Assistant for general questions');
        }
        const c = await repo.conversations.ensureForCase(req.params.id);
        if (!c) throw notFound();
        return toConversationSummary(c);
      },
    );
  };
