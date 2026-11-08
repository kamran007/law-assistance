import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en, problem, renderIn, stubApi, type ApiStub } from './helpers';

/** WEB-04 Law Verifier: word diff, panel by role (point-in-time + history for professionals only). */
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
const { wordDiff, MAX_DIFF_CELLS } = await import('@/lib/diff');
const { citation } = await import('@/lib/verifier');
const { VerifierPanel } = await import('@/components/verifier/verifier-panel');
const { authStore } = await import('@/lib/auth/store');
type Me = import('@/lib/auth/store').Me;

const me = (role: Me['role']): Me => ({ user_id: 'u', full_name: 'U', contact: 'u@e.com', role, requested_role: role, verification_status: role === 'CITIZEN' ? 'NOT_REQUIRED' : 'VERIFIED', preferred_language: 'EN', profile_complete: true });
const act = { act_id: 11, title: 'The Penal Code, 1860', title_en: 'The Penal Code, 1860', title_bn: null, act_number: 'ACT NO. XLV OF 1860', enacted_date: '1860-10-06', status: 'ACTIVE', language: 'EN' };
const version = (v: number, text: string, current: boolean, from: string, to: string | null) => ({
  section_id: `s${v}`,
  sec: '420',
  section_number: '420',
  chapter: 'CHAPTER XVII',
  heading: 'Cheating and dishonestly inducing delivery of property',
  text,
  footnotes: v === 2 ? [{ action: 'SUBSTITUTED', by_act: 'Act XII of 2023', date: '2023-07-01', text: 'Substituted by Act XII of 2023.' }] : [],
  version: v,
  is_current: current,
  valid_from: from,
  valid_to: to,
  valid_from_source: 'AMENDMENT_FOOTNOTE',
});
const OLD = 'shall be punished with imprisonment for a term which may extend to seven years';
const NEW = 'shall be punished with imprisonment for a term which may extend to ten years, and fine';
const schedule = { is_cognizable: true, is_bailable: false, is_compoundable: false, max_punishment: '7 years and fine', triable_by_court: 'Magistrate of the first class', effective_from: '1898-07-01' };

let api: ApiStub;
beforeEach(() => {
  api = stubApi();
  api.routes['GET /api/v1/statutes/11/sections/420'] = (_req, url) =>
    Response.json({
      act,
      section: url.searchParams.get('as_of') ? version(1, OLD, false, '1860-10-06', '2023-07-01') : version(2, NEW, true, '2023-07-01', null),
      law_as_of: url.searchParams.get('as_of'),
      current_version: 2,
      schedule_ii: schedule,
    });
  api.routes['GET /api/v1/statutes/11/sections/420/versions'] = () => Response.json({ act, sec: '420', versions: [version(1, OLD, false, '1860-10-06', '2023-07-01'), version(2, NEW, true, '2023-07-01', null)] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  authStore.clear();
});

describe('wordDiff', () => {
  it('marks removed and added words and keeps the rest verbatim', () => {
    const parts = wordDiff(OLD, NEW);
    expect(parts.filter((p) => p.kind === 'removed').map((p) => p.text.trim())).toEqual(['seven years']);
    expect(parts.filter((p) => p.kind === 'added').map((p) => p.text.trim())).toEqual(['ten years, and fine']);
    expect(parts.filter((p) => p.kind !== 'added').map((p) => p.text).join('')).toBe(OLD);
    expect(parts.filter((p) => p.kind !== 'removed').map((p) => p.text).join('')).toBe(NEW);
  });

  it('works on Bangla text and falls back to whole replacement for huge inputs', () => {
    const parts = wordDiff('যে কেহ প্রতারণা করে সাত বছর', 'যে কেহ প্রতারণা করে দশ বছর');
    expect(parts.find((p) => p.kind === 'removed')?.text).toBe('সাত');
    expect(parts.find((p) => p.kind === 'added')?.text).toBe('দশ');
    const big = Array.from({ length: Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10 }, (_, i) => `w${i}`).join(' ');
    expect(wordDiff(big, `${big} x`).map((p) => p.kind)).toEqual(['removed', 'added']);
  });

  it('citation text, with the date for point-in-time law', () => {
    expect(citation('The Penal Code, 1860', '420', 'en')).toBe('The Penal Code, 1860, s. 420');
    expect(citation('The Penal Code, 1860', '420', 'en', '2020-01-01')).toBe('The Penal Code, 1860, s. 420 (as in force on 2020-01-01)');
    expect(citation('দণ্ডবিধি', '৪২০', 'bn')).toBe('দণ্ডবিধি, ধারা ৪২০');
  });
});

describe('VerifierPanel', () => {
  it('Citizen: current text only (no as_of request even when asked), no version history; Schedule II strip', async () => {
    authStore.setSession('at', 900, me('CITIZEN'));
    renderIn(<VerifierPanel target={{ actId: 11, sec: '420', asOf: '2020-01-01' }} onClose={() => undefined} />);
    expect(await screen.findByText(/ten years, and fine/)).toBeTruthy();
    expect(api.calls.map((c) => c.path)).toEqual(['/api/v1/statutes/11/sections/420']);
    expect(api.calls[0]!.headers.get('authorization')).toBe('Bearer at');
    expect(screen.queryByRole('button', { name: en.verifier.history })).toBeNull();
    const dialog = screen.getByRole('dialog', { name: en.verifier.title });
    expect(dialog.textContent).toContain('Cognizable · Non-bailable · Non-compoundable · Max punishment: 7 years and fine · Magistrate of the first class');
    expect(dialog.textContent).toContain('Substituted by Act XII of 2023.');
    expect(within(dialog).getByRole('link', { name: en.verifier.openAct }).getAttribute('href')).toBe('/library/11');
  });

  it('Lawyer: the text as in force on the date, flagged when the current wording differs', async () => {
    authStore.setSession('at', 900, me('LAWYER'));
    renderIn(<VerifierPanel target={{ actId: 11, sec: '420', asOf: '2020-01-01' }} onClose={() => undefined} />);
    expect(await screen.findByText(/seven years/)).toBeTruthy();
    expect(new URL(`http://x${api.calls[0]!.path}`).pathname).toBe('/api/v1/statutes/11/sections/420');
    expect(screen.getByText(/Text as in force on/).textContent).toContain(en.verifier.currentDiffers.replace('{version}', '2'));
  });

  it('Lawyer: version history and a word diff against the current version', async () => {
    authStore.setSession('at', 900, me('JUDGE'));
    renderIn(<VerifierPanel target={{ actId: 11, sec: '420' }} onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: en.verifier.history }));
    await userEvent.click(await screen.findByRole('button', { name: en.verifier.compare }));
    const diff = screen.getByLabelText(en.verifier.diffLabel);
    expect(diff.querySelector('del')?.textContent?.trim()).toBe('seven years');
    expect(diff.querySelector('ins')?.textContent?.trim()).toBe('ten years, and fine');
  });

  it('copies the citation, closes on Escape, and reports a missing section', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onClose = vi.fn();
    authStore.setSession('at', 900, me('CITIZEN'));
    const { unmount } = renderIn(<VerifierPanel target={{ actId: 11, sec: '420' }} onClose={onClose} />);
    await userEvent.click(await screen.findByRole('button', { name: en.verifier.copy }));
    expect(writeText).toHaveBeenCalledWith('The Penal Code, 1860, s. 420');
    expect(screen.getByRole('button', { name: en.verifier.copied })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    unmount();

    api.routes['GET /api/v1/statutes/11/sections/999'] = () => problem(404, 'SECTION_NOT_FOUND');
    renderIn(<VerifierPanel target={{ actId: 11, sec: '999' }} onClose={() => undefined} />);
    expect(await screen.findByText(en.verifier.notFound)).toBeTruthy();
  });
});

describe('opening from the scan result', () => {
  it('a section row opens the verifier at the occurrence date for a Lawyer', async () => {
    vi.doMock('@/i18n/navigation', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a>, useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/' }));
    const { VerifierProvider } = await import('@/components/verifier/verifier-panel');
    const { SectionsTable } = await import('@/components/scan/sections-table');
    authStore.setSession('at', 900, me('LAWYER'));
    const section = { key: '420', section: '৪২০', subsection: null, act: { key: 'PENAL_CODE', name: 'Penal Code', bdlawsActId: 11 }, actInferred: false, source: 'DETECTOR' as const, scheduleStatus: 'NOT_IN_VERIFIED_SCHEDULE' as const, schedule: null };
    renderIn(
      <VerifierProvider>
        <SectionsTable sections={[section]} scheduleDate="2020-01-01" lawDate="2020-01-01" />
      </VerifierProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Penal Code, s. ৪২০' }));
    expect(await screen.findByRole('dialog', { name: en.verifier.title })).toBeTruthy();
    await waitFor(() => expect(api.calls.at(-1)?.path).toBe('/api/v1/statutes/11/sections/420'));
    expect(await screen.findByText(/seven years/)).toBeTruthy(); // the as_of text
  });
});
