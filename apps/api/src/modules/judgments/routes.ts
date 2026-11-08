import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { normalizeSectionKey } from '@lawassist/legal-text';
import { ApiError } from '../../problem';
import type { DocumentStorage } from '../documents/storage';
import type { JudgmentRow, JudgmentsRepository } from './repository';
import {
  judgmentDetail,
  judgmentIdParam,
  judgmentList,
  judgmentListQuery,
  sectionJudgments,
  sectionJudgmentsParams,
  sectionJudgmentsQuery,
} from './schemas';

export interface JudgmentRoutesDeps {
  repo: JudgmentsRepository;
  /** Presigned GET for the stored original PDF (public data, same bucket as uploads). */
  storage: Pick<DocumentStorage, 'presignGet'>;
}

/** The original PDF link is short-lived; the page can ask again. */
export const JUDGMENT_PDF_URL_TTL_SECONDS = 10 * 60;

const textAvailable = (j: JudgmentRow) => j.extractionStatus !== 'NEEDS_REVIEW' && !!j.fullText?.trim();

const summary = (j: JudgmentRow) => ({
  judgment_id: j.judgmentId,
  citation: j.citation,
  parties: j.parties,
  division: j.division,
  issue: j.issueNumber,
  issue_year: j.issueYear,
  serial: j.serialNumber,
  case_number: j.caseNumber,
  authoring_judge: j.authoringJudge,
  decision_date: j.decisionDate,
  key_words: j.keyWords,
  language: j.language,
  text_available: textAvailable(j),
});

const MARKER = /^\[para (\d+)\]\s*/;

/** `[para n]` text → preamble + numbered paragraphs, wrapped lines joined. */
export function splitParagraphs(fullText: string): { preamble: string | null; paragraphs: { n: number; text: string }[] } {
  const pre: string[] = [];
  const paragraphs: { n: number; lines: string[] }[] = [];
  for (const raw of fullText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = MARKER.exec(line);
    if (m) paragraphs.push({ n: Number(m[1]), lines: [line.slice(m[0].length)] });
    else if (paragraphs.length) paragraphs.at(-1)!.lines.push(line);
    else pre.push(line);
  }
  return {
    preamble: pre.length ? pre.join('\n') : null,
    paragraphs: paragraphs.map((p) => ({ n: p.n, text: p.lines.join(' ').replace(/\s+/g, ' ').trim() })),
  };
}

/** Case-law read API (TRD §5.1, §6A.5; JUD-07): Law Library case law and the verifier's "Judgments on this section". */
export const judgmentRoutes =
  (deps: JudgmentRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { repo } = deps;
    const keyOr422 = (sec: string) => {
      const key = normalizeSectionKey(sec);
      if (!key) throw new ApiError(422, 'INVALID_SECTION', 'Invalid section number', 'Use a section number like 420, 561A or ৪২০');
      return key;
    };

    app.get(
      '/judgments',
      {
        config: { access: 'public', rateLimit: { max: 60, timeWindow: '10 minutes' } },
        schema: { tags: ['judgments'], summary: 'Search case law (Supreme Court Online Bulletin)', querystring: judgmentListQuery, response: { 200: judgmentList } },
      },
      async (req) => {
        const { act_id, sec, ...rest } = req.query;
        if (sec && !act_id) throw new ApiError(422, 'SECTION_NEEDS_ACT', 'A section filter needs act_id', 'Add act_id, e.g. act_id=11&sec=302');
        const sectionKey = sec ? keyOr422(sec) : undefined;
        let statuteId: string | undefined;
        if (act_id) {
          statuteId = await repo.statuteIdByActId(act_id);
          if (!statuteId) return { total: 0, limit: rest.limit, offset: rest.offset, items: [] };
        }
        const { total, items } = await repo.search({ ...rest, statuteId, sectionKey });
        return { total, limit: rest.limit, offset: rest.offset, items: items.map(summary) };
      },
    );

    app.get(
      '/judgments/:judgment_id',
      {
        config: { access: 'public' },
        schema: { tags: ['judgments'], summary: 'A judgment: metadata, text by paragraph, linked sections, original PDF', params: judgmentIdParam, response: { 200: judgmentDetail } },
      },
      async (req) => {
        const j = await repo.byId(req.params.judgment_id);
        if (!j) throw new ApiError(404, 'JUDGMENT_NOT_FOUND', 'Judgment not found');
        const text = textAvailable(j) ? splitParagraphs(j.fullText!) : { preamble: null, paragraphs: [] };
        const refs = await repo.refs(j.judgmentId);
        const pdfUrl = j.storedPdfKey
          ? await deps.storage.presignGet(j.storedPdfKey, {
              ttlSeconds: JUDGMENT_PDF_URL_TTL_SECONDS,
              contentType: 'application/pdf',
              disposition: 'inline',
              filename: `${j.citation.replace(/[^\w.-]+/g, '_')}_${j.serialNumber}.pdf`,
            })
          : null;
        return {
          ...summary(j),
          bench: j.bench ?? [],
          summary: j.summary,
          key_ratio_paragraphs: j.keyRatioParagraphs,
          decision_date_source: j.decisionDateSource,
          extraction_status: j.extractionStatus,
          preamble: text.preamble,
          paragraphs: text.paragraphs,
          linked_sections: refs.map((r) => ({
            act_id: r.bdlawsActId,
            act_title: r.titleEn ?? r.titleBn,
            sec: r.sectionKey,
            raw: r.raw,
            paragraphs: r.paragraphs,
            found_in: r.foundIn,
          })),
          pdf_url: pdfUrl,
          source_pdf_url: j.sourcePdfUrl,
        };
      },
    );

    app.get(
      '/statutes/:act_id/sections/:sec/judgments',
      {
        config: { access: 'public' },
        schema: {
          tags: ['judgments'],
          summary: 'Judgments that discuss this section (newest first)',
          params: sectionJudgmentsParams,
          querystring: sectionJudgmentsQuery,
          response: { 200: sectionJudgments },
        },
      },
      async (req) => {
        const key = keyOr422(req.params.sec);
        const statuteId = await repo.statuteIdByActId(req.params.act_id);
        if (!statuteId) throw new ApiError(404, 'STATUTE_NOT_FOUND', 'Statute not found');
        const current = await repo.currentSection(statuteId, key);
        if (!current) throw new ApiError(404, 'SECTION_NOT_FOUND', 'Section not found');
        const { total, items } = await repo.bySection(statuteId, key, req.query);
        // FR-D6: a judgment interprets the section as it stood on the decision date.
        const amendedOn = current.versionNumber > 1 ? current.validFrom : null;
        return {
          act_id: req.params.act_id,
          sec: key,
          total,
          limit: req.query.limit,
          offset: req.query.offset,
          items: items.map(({ row, paragraphs }) => ({
            ...summary(row),
            paragraphs,
            older_than_current_version: row.decisionDate ? row.decisionDate < current.validFrom : null,
            section_amended_on: amendedOn,
          })),
        };
      },
    );
  };
