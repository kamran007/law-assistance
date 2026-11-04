import { scoped, type Db } from '@lawassist/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, type Authenticate } from '../../auth';
import { ApiError } from '../../problem';
import { conversationSummary, message, toConversationSummary, toMessage } from './schemas';

export interface ConversationRoutesDeps {
  db: Db;
  authenticate: Authenticate;
}

const idParam = z.object({ id: z.uuid() });
const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

/**
 * Conversations (TRD §5.1, App Flow §4–5; BE-12). Lists and creation cover GENERAL conversations
 * only; a case conversation is reached through its case (`/cases/{id}/conversation`) and then by
 * its own id. Messages are written by the assistant endpoint (BE-13), not here.
 */
export const conversationRoutes =
  (deps: ConversationRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const repoFor = async (req: Parameters<Authenticate>[0]) => scoped(deps.db, requireAuth(await deps.authenticate(req)).userId);

    app.get(
      '/conversations',
      {
        config: { access: 'tenant' },
        schema: { tags: ['conversations'], summary: 'My general conversations, newest first', response: { 200: z.object({ items: z.array(conversationSummary) }) } },
      },
      async (req) => ({ items: (await (await repoFor(req)).conversations.listGeneral()).map(toConversationSummary) }),
    );

    app.post(
      '/conversations',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['conversations'],
          summary: 'Start a general conversation (never linked to a case)',
          body: z.object({ title: z.string().trim().min(1).max(300).optional(), language: z.enum(['BN', 'EN']).optional() }).strict(),
          response: { 201: conversationSummary },
        },
      },
      async (req, reply) => {
        const repo = await repoFor(req);
        const c = await repo.conversations.createGeneral({ title: req.body.title ?? null, ...(req.body.language ? { language: req.body.language } : {}) });
        return reply.status(201).send(toConversationSummary(c));
      },
    );

    app.get(
      '/conversations/:id',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['conversations'],
          summary: 'A conversation with a page of messages (oldest first); page back with `before`',
          params: idParam,
          querystring: z.object({ before: z.iso.datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
          response: { 200: conversationSummary.extend({ messages: z.array(message), has_more: z.boolean() }) },
        },
      },
      async (req) => {
        const repo = await repoFor(req);
        const c = await repo.conversations.findById(req.params.id);
        if (!c) throw notFound();
        // One extra row tells whether an older page exists.
        const rows = await repo.messages.byConversation(c.conversationId, {
          limit: req.query.limit + 1,
          ...(req.query.before ? { before: new Date(req.query.before) } : {}),
        });
        if (!rows) throw notFound();
        const hasMore = rows.length > req.query.limit;
        return { ...toConversationSummary(c), messages: (hasMore ? rows.slice(1) : rows).map(toMessage), has_more: hasMore };
      },
    );

    app.patch(
      '/conversations/:id',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['conversations'],
          summary: 'Rename a conversation',
          params: idParam,
          body: z.object({ title: z.string().trim().min(1).max(300) }).strict(),
          response: { 200: conversationSummary },
        },
      },
      async (req) => {
        const repo = await repoFor(req);
        if (!(await repo.conversations.rename(req.params.id, req.body.title))) throw notFound();
        const c = await repo.conversations.findById(req.params.id);
        if (!c) throw notFound();
        return toConversationSummary(c);
      },
    );

    app.delete(
      '/conversations/:id',
      {
        config: { access: 'tenant' },
        schema: { tags: ['conversations'], summary: 'Delete a general conversation', params: idParam, response: { 204: z.null() } },
      },
      async (req, reply) => {
        const repo = await repoFor(req);
        const c = await repo.conversations.findById(req.params.id);
        if (!c) throw notFound();
        if (c.caseFileId) {
          throw new ApiError(409, 'CASE_CONVERSATION', 'A case conversation is deleted together with its case', 'Delete the case instead');
        }
        if (!(await repo.conversations.softDelete(c.conversationId))) throw notFound();
        return reply.status(204).send(null);
      },
    );
  };
