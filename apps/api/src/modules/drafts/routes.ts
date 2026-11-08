import { newId, scoped, type CaseArtifact, type Db } from '@lawassist/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireProfessional, type Authenticate } from '../../auth';
import { requireIfMatch, setVersionEtag } from '../../http';
import { ApiError } from '../../problem';
import { DRAFT_HTML_MAX_BYTES, sanitizeDraftHtml } from './sanitize';
import { findTemplate, renderTemplate, templatesFor, type DraftRole } from './templates';

export interface DraftRoutesDeps {
  db: Db;
  authenticate: Authenticate;
}

const lang = z.enum(['BN', 'EN']);
const caseParam = z.object({ id: z.uuid() });
const draftParams = caseParam.extend({ art_id: z.uuid() });

export const draftSchema = z.object({
  artifact_id: z.string(),
  case_id: z.string(),
  template_key: z.string().nullable(),
  html: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
const toDraft = (a: CaseArtifact): z.infer<typeof draftSchema> => ({
  artifact_id: a.artifactId,
  case_id: a.caseFileId,
  template_key: a.templateKey,
  html: a.editableDocumentHtml ?? '',
  version: a.version,
  created_at: a.createdAt.toISOString(),
  updated_at: a.updatedAt.toISOString(),
});

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');
/** ADMIN may use professional features; drafts use the Lawyer templates for them. */
const draftRole = (role: string): DraftRole => (role === 'JUDGE' ? 'JUDGE' : 'LAWYER');

/**
 * Drafts (App Flow §10; BE-32 templates, BE-33 save). Lawyers and Judges only (verified). Drafts
 * are `VOICE_DICTATION_DRAFT` artifacts of a case, reached through `scoped()` like any artifact.
 * Saving is last-write-wins with the overwritten text preserved (TRD §5.4).
 */
export const draftRoutes =
  (deps: DraftRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const auth = async (req: Parameters<Authenticate>[0]) => {
      const p = requireProfessional(await deps.authenticate(req), 'Drafts');
      return { p, repo: scoped(deps.db, p.userId) };
    };

    app.get(
      '/draft-templates',
      {
        config: { access: 'self' },
        schema: {
          tags: ['drafts'],
          summary: 'Draft templates for my role (Lawyer or Judge)',
          response: { 200: z.object({ items: z.array(z.object({ key: z.string(), title_bn: z.string(), title_en: z.string(), headings_bn: z.array(z.string()), headings_en: z.array(z.string()) })) }) },
        },
      },
      async (req) => {
        const { p } = await auth(req);
        return { items: templatesFor(draftRole(p.role)).map((t) => ({ key: t.key, title_bn: t.title.BN, title_en: t.title.EN, headings_bn: t.headings.BN, headings_en: t.headings.EN })) };
      },
    );

    app.post(
      '/cases/:id/drafts',
      {
        config: { access: 'tenant', rateLimit: { max: 60, timeWindow: '1 hour' } },
        schema: {
          tags: ['drafts'],
          summary: 'Create a draft from a template, headings pre-filled with the case number and court',
          params: caseParam,
          body: z.object({ template_key: z.string().max(64), language: lang.default('BN') }).strict(),
          response: { 201: draftSchema },
        },
      },
      async (req, reply) => {
        const { p, repo } = await auth(req);
        const c = await repo.caseFiles.findById(req.params.id);
        if (!c) throw notFound();
        const template = findTemplate(req.body.template_key, draftRole(p.role));
        if (!template) throw new ApiError(422, 'UNKNOWN_TEMPLATE', 'No such template for your role');
        const html = renderTemplate(template, req.body.language, { caseNumber: c.caseNumber, court: c.courtOrThana, title: c.title });
        const created = await repo.artifacts.createDraft({ artifactId: newId(), caseFileId: c.caseFileId, templateKey: template.key, html });
        if (!created) throw notFound();
        setVersionEtag(reply, created.version);
        return reply.status(201).send(toDraft(created));
      },
    );

    app.get(
      '/cases/:id/drafts/:art_id',
      { config: { access: 'tenant' }, schema: { tags: ['drafts'], summary: 'A draft with its HTML', params: draftParams, response: { 200: draftSchema } } },
      async (req, reply) => {
        const { repo } = await auth(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        if (!a || a.caseFileId !== req.params.id || a.artifactType !== 'VOICE_DICTATION_DRAFT') throw notFound();
        setVersionEtag(reply, a.version);
        return toDraft(a);
      },
    );

    app.patch(
      '/cases/:id/drafts/:art_id',
      {
        // Autosave runs every few seconds while typing.
        config: { access: 'tenant', rateLimit: { max: 2000, timeWindow: '1 hour' } },
        bodyLimit: 2 * DRAFT_HTML_MAX_BYTES,
        schema: {
          tags: ['drafts'],
          summary: 'Save draft HTML (If-Match). On a version mismatch the newer server text is preserved and X-Conflict-Preserved names it',
          params: draftParams,
          body: z.object({ html: z.string().max(DRAFT_HTML_MAX_BYTES) }).strict(),
          response: { 200: draftSchema },
        },
      },
      async (req, reply) => {
        const { repo } = await auth(req);
        const expected = requireIfMatch(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        if (!a || a.caseFileId !== req.params.id) throw notFound();
        const device = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'].slice(0, 100) : null;
        const res = await repo.artifacts.saveDraft(a.artifactId, expected, sanitizeDraftHtml(req.body.html), device);
        if (res.status === 'not_found' || res.status === 'not_a_draft') throw notFound();
        if (res.preservedRevisionId) reply.header('x-conflict-preserved', res.preservedRevisionId);
        setVersionEtag(reply, res.row.version);
        return toDraft(res.row);
      },
    );

    app.get(
      '/cases/:id/drafts/:art_id/revisions',
      {
        config: { access: 'tenant' },
        schema: {
          tags: ['drafts'],
          summary: 'Earlier versions of a draft that were preserved on save conflicts',
          params: draftParams,
          response: { 200: z.object({ items: z.array(z.object({ revision_id: z.string(), version: z.number().int(), html: z.string(), created_by_device: z.string().nullable(), created_at: z.string() })) }) },
        },
      },
      async (req) => {
        const { repo } = await auth(req);
        const a = await repo.artifacts.findById(req.params.art_id);
        if (!a || a.caseFileId !== req.params.id || a.artifactType !== 'VOICE_DICTATION_DRAFT') throw notFound();
        const rows = (await repo.artifacts.draftRevisions(a.artifactId)) ?? [];
        return {
          items: rows.map((r) => ({ revision_id: r.revisionId, version: r.version, html: r.editableDocumentHtml ?? '', created_by_device: r.createdByDevice, created_at: r.createdAt.toISOString() })),
        };
      },
    );
  };
