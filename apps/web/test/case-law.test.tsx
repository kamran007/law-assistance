import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bn, en, problem, renderIn, stubApi, type ApiStub } from './helpers';

/** WEB-12 "Judgments on this section" (App Flow §7.1, §7.3; FR-D6). */
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, className }: { href: string | { pathname: string; query: Record<string, string> }; children: ReactNode; className?: string }) => (
    <a href={typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query)}`} className={className}>
      {children}
    </a>
  ),
}));
const { SectionJudgments } = await import('@/components/case-law/section-judgments');

const item = (id: string, over: Record<string, unknown> = {}) => ({
  judgment_id: id,
  citation: '20 SCOB [2025] AD',
  parties: `Party ${id} Vs. The State`,
  division: 'AD',
  issue: 20,
  issue_year: 2025,
  serial: 1,
  case_number: null,
  authoring_judge: null,
  decision_date: '2019-08-25',
  key_words: '',
  language: 'EN',
  text_available: true,
  paragraphs: ['12', '14'],
  older_than_current_version: false,
  section_amended_on: null,
  ...over,
});

let api: ApiStub;
beforeEach(() => {
  api = stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('SectionJudgments', () => {
  it('lists judgments with a link to the first citing paragraph, warns when decided before the amendment, links to all', async () => {
    api.routes['GET /api/v1/statutes/11/sections/302/judgments'] = (_req, url) => {
      expect(url.searchParams.get('limit')).toBe('5');
      return Response.json({
        act_id: 11,
        sec: '302',
        total: 7,
        limit: 5,
        offset: 0,
        items: [item('a', { older_than_current_version: true, section_amended_on: '2025-03-01' }), item('b', { division: 'HCD', paragraphs: [], decision_date: null, older_than_current_version: null })],
      });
    };
    renderIn(<SectionJudgments actId={11} sec="302" />);
    const first = await screen.findByRole('link', { name: 'Party a Vs. The State' });
    expect(first.getAttribute('href')).toBe('/library/judgments/a#para-12');
    expect(screen.getByRole('link', { name: 'Party b Vs. The State' }).getAttribute('href')).toBe('/library/judgments/b');
    expect(screen.getByText(/paras 12, 14/)).toBeTruthy();
    expect(screen.getByText('Decided before this section was amended on Mar 1, 2025.')).toBeTruthy();
    expect(screen.getAllByText(/Decided before/)).toHaveLength(1); // unknown date → no warning
    expect(screen.getByText(/High Court Division/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See all 7 judgments' }).getAttribute('href')).toBe('/library/judgments?act_id=11&sec=302');
  });

  it('says so when no judgment discusses the section (Bangla)', async () => {
    api.routes['GET /api/v1/statutes/11/sections/34/judgments'] = () => Response.json({ act_id: 11, sec: '34', total: 0, limit: 5, offset: 0, items: [] });
    renderIn(<SectionJudgments actId={11} sec="34" />, 'bn');
    expect(await screen.findByText(bn.caseLaw.noneOnSection)).toBeTruthy();
    expect(screen.getByRole('heading', { name: bn.caseLaw.onSection })).toBeTruthy();
  });

  it('renders nothing for an unknown section, and an error line when the API fails', async () => {
    api.routes['GET /api/v1/statutes/11/sections/999/judgments'] = () => problem(404, 'SECTION_NOT_FOUND');
    const { container } = renderIn(<SectionJudgments actId={11} sec="999" />);
    await vi.waitFor(() => expect(api.calls).toHaveLength(1));
    await vi.waitFor(() => expect(container.textContent).toBe(''));

    api.routes['GET /api/v1/statutes/11/sections/420/judgments'] = () => problem(500, 'INTERNAL');
    renderIn(<SectionJudgments actId={11} sec="420" />);
    // One retry (1 s) before the error shows.
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveProperty('textContent', en.caseLaw.loadFailed);
  });
});
