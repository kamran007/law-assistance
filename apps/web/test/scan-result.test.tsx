import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bn, en, problem, renderIn, stubApi, type ApiStub } from './helpers';

/** WEB-08 Scan Result screen in jsdom, with analyses shaped as the worker stores them. */
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/cases/x/documents/y',
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
const { ScanResult } = await import('@/components/scan/scan-result');

const CASE = '0190a000-0000-7000-8000-0000000000c1';
const ART = '0190a000-0000-7000-8000-0000000000a1';
const URL_ = `/api/v1/cases/${CASE}/artifacts/${ART}`;

const penal = { key: 'PENAL_CODE', name: 'Penal Code', bdlawsActId: 11 };
const ANALYSIS = {
  version: 1,
  documentKind: 'FIR',
  occurrence: { date: '2024-03-12', time: '21:30', instant: '2024-03-12T15:30:00Z', approximate: true, flags: [] },
  reported: { date: '2024-03-15', time: '10:00', instant: '2024-03-15T04:00:00Z', approximate: false, flags: [] },
  filingDelay: { minutes: 3630, days: 3, basis: 'DATETIME', warning: null },
  scheduleDate: '2024-03-12',
  scheduleDateBasis: 'OCCURRENCE',
  sections: [
    { key: '323', section: '৩২৩', subsection: null, act: penal, actInferred: false, citedTogether: ['323', '34'], source: 'DETECTOR_AND_LLM', scheduleStatus: 'VERIFIED', schedule: { isCognizable: false, isBailable: true, isCompoundable: true, maxPunishment: '1 year', triableByCourt: 'Any Magistrate', offenseDescription: null, matchedSection: '323', effectiveFrom: '1898-07-01', sourceReference: null } },
    { key: '34', section: '৩৪', subsection: null, act: penal, actInferred: true, citedTogether: ['323', '34'], source: 'DETECTOR', scheduleStatus: 'NOT_IN_VERIFIED_SCHEDULE', schedule: null },
  ],
  rejectedSections: [],
  fir: {
    police_station: 'মিরপুর মডেল',
    district: 'ঢাকা',
    fir_number: '১২',
    gr_number: null,
    place_of_occurrence: 'মিরপুর ১০',
    informant: { name: 'রহিম', address: null },
    accused: [{ name: 'করিম', role_in_allegation: 'মারপিট' }],
    witnesses: [{ name: 'সেলিম' }],
    narrative_summary: 'আসামী বাদীকে মারপিট করে।',
    occurrence_datetime_raw: '১২/০৩/২০২৪ রাত অনুমান ০৯.৩০',
    reported_datetime_raw: '১৫/০৩/২০২৪ সকাল ১০.০০',
  },
  extractionModel: 'claude-opus-5-5',
};
const sources = [{ n: 1, sectionId: 's1', sectionRef: 'PENAL_CODE:323', versionNumber: 2, currentTextUsed: false }];
const LAWYER = {
  status: 'READY',
  role: 'LAWYER',
  language: 'EN',
  sources,
  flags: [],
  model: 'm',
  content: {
    sections: [{ section_ref: 'PENAL_CODE:323', ingredients: [{ ingredient: 'Voluntarily causing hurt', status: 'ALLEGED', evidence_in_fir: 'আসামী বাদীকে মারপিট করে', source_ids: [1] }] }],
    delay: { assessment: 'UNEXPLAINED', note: 'Three days pass without an explanation.', evidence_in_fir: null },
    grounds: [{ kind: 'BAIL', ground: 'The offence carries at most one year.', source_ids: [1] }],
  },
};
const detail = (over: object = {}) => ({
  artifact_id: ART,
  case_id: CASE,
  artifact_type: 'FIR_SCAN',
  processing_status: 'READY',
  processing_error: null,
  mime_type: 'application/pdf',
  page_count: 1,
  ocr_confidence: 0.95,
  version: 3,
  created_at: '2026-11-08T09:00:00Z',
  updated_at: '2026-11-08T09:01:00Z',
  structured_analysis: ANALYSIS,
  role_analysis: LAWYER,
  ...over,
});

let api: ApiStub;
beforeEach(() => {
  api = stubApi();
  api.routes[`GET ${URL_}`] = () => Response.json(detail());
});
afterEach(() => vi.unstubAllGlobals());

describe('ScanResult', () => {
  it('FIR details: parsed dates, approximate flag, filing delay warning and parties', async () => {
    renderIn(<ScanResult caseId={CASE} artId={ART} />);
    const fir = (await screen.findByRole('heading', { name: en.scan.fir.title })).closest('section')!;
    expect(fir.textContent).toContain('মিরপুর মডেল');
    expect(fir.textContent).toContain('Mar 12, 2024, 9:30 PM');
    expect(fir.textContent).toContain(`(${en.scan.fir.approximate})`);
    expect(fir.textContent).toContain('⚠ Delay in filing: 2 days 12 hours');
    expect(fir.textContent).toContain('করিম — মারপিট');
    expect(fir.textContent).toContain(en.scan.fir.notStated); // G.R. number
  });

  it('Schedule II table: verified values only; an unverified section shows no status at all', async () => {
    renderIn(<ScanResult caseId={CASE} artId={ART} />);
    const table = await screen.findByRole('table', { name: en.scan.sections.caption });
    const [, verified, unverified] = within(table).getAllByRole('row');
    expect(within(verified!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['No', 'Yes', 'Yes', '1 year', 'Any Magistrate']);
    expect(within(verified!).getByRole('rowheader').textContent).toContain('Penal Code, s. ৩২৩');
    expect(within(unverified!).getAllByRole('cell').map((c) => c.textContent)).toEqual([en.scan.sections.notVerified]);
    expect(unverified!.textContent).toContain(en.scan.sections.actInferred);
  });

  it('Lawyer analysis: ingredient audit with status and FIR quote, delay flag, grounds with citation chips', async () => {
    renderIn(<ScanResult caseId={CASE} artId={ART} />);
    const block = (await screen.findByRole('heading', { name: en.scan.analysis.title })).closest('section')!;
    expect(block.textContent).toContain('Voluntarily causing hurt');
    expect(block.textContent).toContain(en.scan.analysis.ingredient.ALLEGED);
    expect(block.textContent).toContain('“আসামী বাদীকে মারপিট করে”');
    expect(block.textContent).toContain(en.scan.analysis.lawyer.delay.UNEXPLAINED);
    expect(within(block).getAllByText('[1] Penal Code, s. ৩২৩')).toHaveLength(2);
  });

  it('Citizen and Judge layouts', async () => {
    api.routes[`GET ${URL_}`] = () =>
      Response.json(
        detail({
          role_analysis: {
            status: 'READY',
            role: 'CITIZEN',
            sources,
            flags: [],
            content: { summary: 'You were hit; this is a hurt case.', sections: [{ section_ref: 'PENAL_CODE:323', plain_explanation: 'Hurting someone on purpose.', source_ids: [1] }], next_steps: [{ step: 'Get a copy of the FIR.', source_ids: [] }] },
          },
        }),
      );
    const { unmount } = renderIn(<ScanResult caseId={CASE} artId={ART} />);
    expect(await screen.findByText('You were hit; this is a hurt case.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: en.scan.analysis.citizen.nextSteps })).toBeTruthy();
    unmount();

    api.routes[`GET ${URL_}`] = () =>
      Response.json(
        detail({
          role_analysis: {
            status: 'READY',
            role: 'JUDGE',
            sources,
            flags: [],
            content: { sections: [{ section_ref: 'PENAL_CODE:323', ingredients: [{ ingredient: 'Hurt', allegation: null, status: 'UNCLEAR', source_ids: [1] }] }], observations: [{ text: 'No medical report is mentioned.', source_ids: [] }] },
          },
        }),
      );
    renderIn(<ScanResult caseId={CASE} artId={ART} />);
    expect(await screen.findByRole('heading', { name: en.scan.analysis.judge.matrix })).toBeTruthy();
    const judge = screen.getByRole('heading', { name: en.scan.analysis.title }).closest('section')!;
    expect(within(judge).getByText(en.scan.analysis.judge.noAllegation)).toBeTruthy();
    expect(screen.getByText('No medical report is mentioned.')).toBeTruthy();
  });

  it('edit fields: sends only what changed, with If-Match; a changed section asks for a re-run', async () => {
    let patched: unknown = null;
    api.routes[`PATCH ${URL_}`] = async (req) => {
      patched = await req.json();
      return Response.json(detail({ version: 4, structured_analysis: { ...ANALYSIS, fir: { ...ANALYSIS.fir, police_station: 'পল্লবী' }, corrections: { needsReanalysis: true, fields: ['police_station', 'cited_sections'], correctedAt: 'x' } } }));
    };
    api.routes[`POST ${URL_}/reanalyze`] = () => Response.json({ ...detail({ processing_status: 'SCHEDULE_LOOKUP', version: 5 }) }, { status: 202 });
    renderIn(<ScanResult caseId={CASE} artId={ART} />);
    await userEvent.click(await screen.findByRole('button', { name: en.scan.edit.open }));
    const thana = screen.getByLabelText(en.scan.fir.policeStation);
    await userEvent.clear(thana);
    await userEvent.type(thana, 'পল্লবী');
    await userEvent.click(screen.getByRole('button', { name: en.scan.edit.removeSection.replace('{n}', '2') }));
    await userEvent.click(screen.getByRole('button', { name: en.scan.edit.save }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toEqual({ police_station: 'পল্লবী', cited_sections: [{ act_hint: 'Penal Code', section: '৩২৩' }] });
    expect(api.calls.find((c) => c.method === 'PATCH')!.headers.get('if-match')).toBe('"3"');
    await userEvent.click(await screen.findByRole('button', { name: en.scan.edit.reanalyze }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/reanalyze'))).toBe(true));
  });

  it('while processing: progress stepper and "preparing"; no edit button', async () => {
    api.routes[`GET ${URL_}`] = () => Response.json(detail({ processing_status: 'ANALYZING', role_analysis: null }));
    renderIn(<ScanResult caseId={CASE} artId={ART} />);
    expect(await screen.findByText(en.scan.analysis.preparing)).toBeTruthy();
    expect(screen.getByRole('list', { name: en.cases.documents.progressLabel })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.scan.edit.open })).toBeNull();
  });

  it('low OCR confidence banner, unavailable analysis, and Bangla labels', async () => {
    api.routes[`GET ${URL_}`] = () => Response.json(detail({ ocr_confidence: 0.6, role_analysis: { status: 'UNAVAILABLE', reason: 'NO_SECTION_TEXT', role: 'CITIZEN' } }));
    renderIn(<ScanResult caseId={CASE} artId={ART} />, 'bn');
    expect((await screen.findByRole('note')).textContent).toBe(bn.scan.lowConfidence);
    expect(screen.getByText(bn.scan.analysis.unavailable)).toBeTruthy();
    expect(screen.getByRole('heading', { name: bn.scan.fir.title })).toBeTruthy();
  });

  it('"View original scan" opens a tab at once, then points it at the signed link', async () => {
    api.routes[`GET ${URL_}/original`] = () => Response.json({ url: 'https://s3.test/signed', expires_in: 300, mime_type: 'application/pdf' });
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    renderIn(<ScanResult caseId={CASE} artId={ART} />);
    await userEvent.click(await screen.findByRole('button', { name: en.scan.viewOriginal }));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://s3.test/signed'));
    expect(tab.opener).toBeNull();

    api.routes[`GET ${URL_}/original`] = () => problem(404, 'NOT_FOUND');
    await userEvent.click(screen.getByRole('button', { name: en.scan.viewOriginal }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.scan.originalFailed);
    expect(tab.close).toHaveBeenCalled();
    open.mockRestore();
  });

  it('not found (another user’s or a missing document)', async () => {
    api.routes[`GET ${URL_}`] = () => problem(404, 'NOT_FOUND');
    renderIn(<ScanResult caseId={CASE} artId={ART} />);
    expect(await screen.findByText(en.scan.notFound)).toBeTruthy();
  });
});
