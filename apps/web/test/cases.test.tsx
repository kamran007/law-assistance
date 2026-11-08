import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en, problem, renderIn, stubApi, type ApiStub } from './helpers';

/** WEB-06 case list, create form and workspace in jsdom, through the real typed client. */
const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: '/cases/x' }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
  usePathname: () => nav.pathname,
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const { CaseList } = await import('@/components/cases/case-list');
const { CaseForm, dhakaToday } = await import('@/components/cases/case-form');
const { CaseWorkspace, tabsFor } = await import('@/components/cases/case-workspace');
type Me = import('@/lib/auth/store').Me;

const ID = '0190a000-0000-7000-8000-0000000000c1';
const caseFile = (over: object = {}) => ({
  case_id: ID,
  title: 'Rahim v. State',
  case_number: 'G.R. 412/2026',
  court_or_thana: 'Mirpur',
  alleged_offense_date: '2026-03-12',
  version: 1,
  created_at: '2026-11-01T10:00:00.000Z',
  updated_at: '2026-11-02T10:00:00.000Z',
  deleted_at: null,
  ...over,
});
const me = (role: Me['role']): Me => ({
  user_id: 'u1',
  full_name: 'User',
  contact: 'u@example.com',
  role,
  requested_role: role,
  verification_status: role === 'CITIZEN' ? 'NOT_REQUIRED' : 'VERIFIED',
  preferred_language: 'EN',
  profile_complete: true,
});

let api: ApiStub;
beforeEach(() => {
  api = stubApi();
  nav.replace.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('CaseList', () => {
  it('shows an empty state with a link to create one', async () => {
    api.routes['GET /api/v1/cases'] = () => Response.json({ items: [], server_time: 'x' });
    renderIn(<CaseList />);
    expect(await screen.findByText(en.cases.emptyTitle)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.cases.new }).getAttribute('href')).toBe('/cases/new');
  });

  it('lists cases newest change first, linking to each workspace', async () => {
    api.routes['GET /api/v1/cases'] = () =>
      Response.json({
        items: [caseFile({ case_id: 'a', title: 'Older', updated_at: '2026-10-01T00:00:00Z' }), caseFile({ case_id: 'b', title: null, case_number: 'C-9', updated_at: '2026-11-05T00:00:00Z' })],
        server_time: 'x',
      });
    renderIn(<CaseList />);
    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => within(li).getByRole('link').getAttribute('href'))).toEqual(['/cases/b', '/cases/a']);
    expect(items[0]!.textContent).toContain('C-9'); // no title: the case number stands in
  });
});

describe('CaseForm', () => {
  it('sends empty fields as null and refuses a future offense date before calling the API', async () => {
    const submit = vi.fn(async () => undefined);
    renderIn(<CaseForm submitLabel="Create" onSubmit={submit} />);
    await userEvent.type(screen.getByLabelText(en.cases.form.title), '  Rahim v. State ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(submit).toHaveBeenCalledWith({ title: 'Rahim v. State', case_number: null, court_or_thana: null, alleged_offense_date: null });

    submit.mockClear();
    const [y, m, d] = dhakaToday().split('-').map(Number);
    const tomorrow = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
    await userEvent.type(screen.getByLabelText(en.cases.form.offenseDate), tomorrow);
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.OFFENSE_DATE_IN_FUTURE);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('CaseWorkspace', () => {
  beforeEach(() => {
    api.routes[`GET /api/v1/cases/${ID}`] = () => Response.json(caseFile());
    api.routes[`GET /api/v1/cases/${ID}/artifacts`] = () =>
      Response.json({
        items: [
          { artifact_id: 'd1', case_id: ID, artifact_type: 'FIR_SCAN', processing_status: 'READY', processing_error: null, mime_type: 'application/pdf', page_count: 2, ocr_confidence: null, version: 1, created_at: '2026-11-03T09:00:00Z', updated_at: 'x' },
          { artifact_id: 'd2', case_id: ID, artifact_type: 'CHARGE_SHEET', processing_status: 'ANALYZING', processing_error: null, mime_type: 'image/jpeg', page_count: 1, ocr_confidence: null, version: 1, created_at: '2026-11-04T09:00:00Z', updated_at: 'x' },
        ],
      });
  });

  it('tabs by role: Citizens see Overview and Documents; verified Lawyers / Judges also Drafts and Conversation', async () => {
    expect(tabsFor(me('CITIZEN'))).toEqual(['overview', 'documents']);
    expect(tabsFor(me('JUDGE'))).toEqual(['overview', 'documents', 'drafts', 'conversation']);
    // A Lawyer still awaiting verification has the effective role CITIZEN.
    const pendingLawyer: Me = { ...me('CITIZEN'), requested_role: 'LAWYER', verification_status: 'PENDING' };
    expect(tabsFor(pendingLawyer)).toEqual(['overview', 'documents']);

    renderIn(<CaseWorkspace id={ID} user={me('CITIZEN')} tab="conversation" />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([en.cases.tabs.overview, en.cases.tabs.documents]);
    // A tab the role can't see falls back to Overview, and the conversation is never fetched.
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(api.calls.some((c) => c.path.endsWith('/conversation'))).toBe(false);
  });

  it('overview shows the details and document count; switching tabs updates the URL', async () => {
    renderIn(<CaseWorkspace id={ID} user={me('LAWYER')} tab={null} />);
    expect(await screen.findByRole('heading', { name: 'Rahim v. State' })).toBeTruthy();
    const panel = screen.getByRole('tabpanel');
    expect(panel.textContent).toContain('G.R. 412/2026');
    expect(panel.textContent).toContain('March 12, 2026');
    await waitFor(() => expect(within(panel).getByText('2')).toBeTruthy());
    await userEvent.click(screen.getByRole('tab', { name: en.cases.tabs.documents }));
    expect(nav.replace).toHaveBeenCalledWith({ pathname: '/cases/x', query: { tab: 'documents' } }, { scroll: false });
  });

  it('documents tab lists types and processing status', async () => {
    renderIn(<CaseWorkspace id={ID} user={me('CITIZEN')} tab="documents" />);
    // Document cards only (each card's progress stepper is a nested list).
    const items = (await screen.findAllByRole('listitem')).filter((li) => li.parentElement?.tagName === 'UL');
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining('FIR'), expect.stringContaining('Charge sheet')]);
    expect(items[0]!.textContent).toContain(en.cases.documents.status.READY);
    expect(items[1]!.textContent).toContain(en.cases.documents.status.ANALYZING);
  });

  it('edits with If-Match and shows a conflict when the case changed elsewhere', async () => {
    let patches = 0;
    api.routes[`PATCH /api/v1/cases/${ID}`] = () => (++patches === 1 ? Response.json(caseFile({ court_or_thana: 'Pallabi', version: 2 })) : problem(409, 'VERSION_CONFLICT'));
    renderIn(<CaseWorkspace id={ID} user={me('LAWYER')} tab={null} />);
    await userEvent.click(await screen.findByRole('button', { name: en.cases.edit }));
    const court = screen.getByLabelText(en.cases.form.court);
    await userEvent.clear(court);
    await userEvent.type(court, 'Pallabi');
    await userEvent.click(screen.getByRole('button', { name: en.cases.form.save }));
    expect(await screen.findByText('Pallabi')).toBeTruthy();
    const patch = api.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.headers.get('if-match')).toBe('"1"');
    expect(patch.body).toMatchObject({ court_or_thana: 'Pallabi', case_number: 'G.R. 412/2026' });

    await userEvent.click(screen.getByRole('button', { name: en.cases.edit }));
    await userEvent.click(screen.getByRole('button', { name: en.cases.form.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.VERSION_CONFLICT);
  });

  it('deletes only after confirmation, then returns to the list', async () => {
    api.routes[`DELETE /api/v1/cases/${ID}`] = () => new Response(null, { status: 204 });
    renderIn(<CaseWorkspace id={ID} user={me('CITIZEN')} tab={null} />);
    await userEvent.click(await screen.findByRole('button', { name: en.cases.delete }));
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('alertdialog').textContent).toContain(en.cases.deleteConfirmBody);
    await userEvent.click(screen.getByRole('button', { name: en.cases.deleteConfirm }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/cases'));
    expect(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/api/v1/cases/${ID}`]);
  });

  it("someone else's (or a missing) case: not found, without retrying", async () => {
    api.routes[`GET /api/v1/cases/${ID}`] = () => problem(404, 'NOT_FOUND');
    renderIn(<CaseWorkspace id={ID} user={me('CITIZEN')} tab={null} />);
    expect(await screen.findByText(en.cases.notFound)).toBeTruthy();
    expect(api.calls.filter((c) => c.path === `/api/v1/cases/${ID}`)).toHaveLength(1);
  });

  it('conversation tab (Lawyer) loads the case conversation', async () => {
    api.routes[`GET /api/v1/cases/${ID}/conversation`] = () => Response.json({ conversation_id: 'cv1', case_id: ID, title: 'Rahim v. State', language: 'BN', created_at: 'x', updated_at: 'x' });
    renderIn(<CaseWorkspace id={ID} user={me('LAWYER')} tab="conversation" />);
    expect(await screen.findByText(/conversation is ready/)).toBeTruthy();
  });
});
