import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { normalizeSectionKey } from '@lawassist/legal-text';
import type { z } from 'zod';
import { requireProfessional, type Authenticate } from '../../auth';
import { ApiError } from '../../problem';
import type { SectionCache } from './cache';
import type { ScheduleRow, SectionRow, StatuteRow, StatutesRepository } from './repository';
import {
  actIdParam,
  sectionParams,
  sectionQuery,
  sectionResponse,
  statuteDetail,
  statuteList,
  statuteListQuery,
  versionsResponse,
} from './schemas';
import { groupByChapter } from './section-order';

export interface StatuteRoutesDeps {
  repo: StatutesRepository;
  cache: SectionCache;
  authenticate: Authenticate;
  /** Today's date in Asia/Dhaka (YYYY-MM-DD); injectable for tests. */
  today: () => string;
}

const summary = (s: StatuteRow) => ({
  act_id: s.bdlawsActId,
  title: s.titleEn ?? s.titleBn ?? '',
  title_en: s.titleEn,
  title_bn: s.titleBn,
  act_number: s.actNumber,
  enacted_date: s.enactedDate,
  status: s.status,
  language: s.language,
});

const version = (r: SectionRow): z.infer<typeof sectionResponse>['section'] => ({
  section_id: r.sectionId,
  sec: r.normalizedSectionKey,
  section_number: r.sectionNumber,
  chapter: r.chapterReference,
  heading: r.marginalHeading,
  text: r.contentBody,
  footnotes: r.amendmentFootnotes.map((f) => ({ action: f.action, by_act: f.byAct, date: f.date, text: f.text })),
  version: r.versionNumber,
  is_current: r.isCurrent,
  valid_from: r.validFrom,
  valid_to: r.validTo,
  valid_from_source: r.validFromSource,
});

const schedule = (r: ScheduleRow | undefined) =>
  r
    ? {
        is_cognizable: r.isCognizable,
        is_bailable: r.isBailable,
        is_compoundable: r.isCompoundable,
        max_punishment: r.maxPunishment,
        triable_by_court: r.triableByCourt,
        effective_from: r.effectiveFrom,
      }
    : null;

/** Statute read API (TRD §5.1, BE-06): Law Library and the Law Verifier panel (App Flow §7). */
export const statuteRoutes =
  (deps: StatuteRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { repo, cache } = deps;

    const actOr404 = async (actId: number) => {
      const act = await repo.byActId(actId);
      if (!act) throw new ApiError(404, 'STATUTE_NOT_FOUND', 'Statute not found');
      return act;
    };
    const keyOr422 = (sec: string) => {
      const key = normalizeSectionKey(sec);
      if (!key) throw new ApiError(422, 'INVALID_SECTION', 'Invalid section number', 'Use a section number like 420, 561A or ৪২০');
      return key;
    };

    app.get(
      '/statutes',
      { config: { access: 'public' }, schema: { tags: ['statutes'], summary: 'Search or list Acts', querystring: statuteListQuery, response: { 200: statuteList } } },
      async (req) => {
        const { total, items } = await repo.search(req.query);
        return { total, limit: req.query.limit, offset: req.query.offset, items: items.map(summary) };
      },
    );

    app.get(
      '/statutes/:act_id',
      { config: { access: 'public' }, schema: { tags: ['statutes'], summary: 'Act detail with its chapter tree', params: actIdParam, response: { 200: statuteDetail } } },
      async (req) => {
        const act = await actOr404(req.params.act_id);
        const outline = await repo.currentSectionOutline(act.statuteId);
        return {
          ...summary(act),
          source_url: act.sourceUrl,
          last_synced_at: act.lastSyncedAt?.toISOString() ?? null,
          chapters: groupByChapter(outline).map((g) => ({
            chapter: g.chapter,
            sections: g.sections.map((s) => ({ sec: s.normalizedSectionKey, section_number: s.sectionNumber, heading: s.marginalHeading })),
          })),
        };
      },
    );

    app.get(
      '/statutes/:act_id/sections/:sec',
      {
        config: { access: 'public' },
        schema: {
          tags: ['statutes'],
          summary: 'Verbatim section text (current, or as of a date for lawyers and judges)',
          params: sectionParams,
          querystring: sectionQuery,
          response: { 200: sectionResponse },
        },
      },
      async (req) => {
        const asOf = req.query.as_of ?? null;
        if (asOf) requireProfessional(await deps.authenticate(req), 'Point-in-time law');
        const key = keyOr422(req.params.sec);

        const cached = await cache.get(req.params.act_id, key, asOf);
        if (cached) return JSON.parse(cached) as z.infer<typeof sectionResponse>;

        const act = await actOr404(req.params.act_id);
        const row = await repo.section(act.statuteId, key, asOf);
        if (!row) {
          const any = asOf ? await repo.versions(act.statuteId, key) : [];
          if (any.length) {
            throw new ApiError(404, 'SECTION_NOT_IN_FORCE', 'Section not in force on that date', `Earliest version is in force from ${any[0]!.validFrom}`);
          }
          throw new ApiError(404, 'SECTION_NOT_FOUND', 'Section not found');
        }
        const current = row.isCurrent ? row : await repo.section(act.statuteId, key, null);
        const body = {
          act: summary(act),
          section: version(row),
          law_as_of: asOf,
          current_version: current?.versionNumber ?? null,
          schedule_ii: schedule(await repo.scheduleRow(act.statuteId, key, asOf ?? deps.today())),
        };
        await cache.set(req.params.act_id, key, asOf, JSON.stringify(body));
        return body;
      },
    );

    app.get(
      '/statutes/:act_id/sections/:sec/versions',
      {
        config: { access: 'public' },
        schema: {
          tags: ['statutes'],
          summary: 'Version history of a section (lawyers and judges)',
          params: sectionParams,
          response: { 200: versionsResponse },
        },
      },
      async (req) => {
        requireProfessional(await deps.authenticate(req), 'Version history');
        const key = keyOr422(req.params.sec);
        const act = await actOr404(req.params.act_id);
        const rows = await repo.versions(act.statuteId, key);
        if (!rows.length) throw new ApiError(404, 'SECTION_NOT_FOUND', 'Section not found');
        return { act: summary(act), sec: key, versions: rows.map(version) };
      },
    );
  };
