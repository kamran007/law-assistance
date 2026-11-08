import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en, renderIn, stubApi, type ApiStub } from './helpers';

/** WEB-10: autosave, Drafts tab with templates, and the editor. */
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.push }),
  usePathname: () => '/',
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
const { useAutosave, saveDraft } = await import('@/lib/drafts');
const { DraftsTab } = await import('@/components/drafts/drafts-tab');
const { DraftEditor } = await import('@/components/drafts/draft-editor');

const CASE = '0190a000-0000-7000-8000-0000000000c1';
const D1 = '0190a000-0000-7000-8000-0000000000d1';
let api: ApiStub;
beforeEach(() => {
  api = stubApi();
  nav.push.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useAutosave', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

  it('saves once after typing stops, with the latest text and the current version', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_html: string, v: number) => ({ draft: { version: v + 1 }, preserved: null }));
    const { result } = renderHook(() => useAutosave({ initialVersion: 3, save, delayMs: 1000 }), { wrapper });
    act(() => result.current.change('<p>a</p>'));
    act(() => result.current.change('<p>ab</p>'));
    expect(result.current.state).toBe('dirty');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(save.mock.calls).toEqual([['<p>ab</p>', 3]]);
    expect(result.current.state).toBe('saved');
    act(() => result.current.change('<p>abc</p>'));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(save.mock.calls[1]).toEqual(['<p>abc</p>', 4]); // the version from the previous save
  });

  it('text typed during a save is saved right after it; a preserved conflict is reported', async () => {
    let release!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (release = () => r({ draft: { version: 2 }, preserved: 'rev-1' }))))
      .mockImplementation(async (_h: string, v: number) => ({ draft: { version: v + 1 }, preserved: null }));
    const { result } = renderHook(() => useAutosave({ initialVersion: 1, save, delayMs: 0 }), { wrapper });
    act(() => result.current.change('<p>one</p>'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    act(() => result.current.change('<p>two</p>'));
    await act(async () => release());
    await waitFor(() => expect(result.current.state).toBe('saved'));
    expect(save.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['<p>one</p>', 1],
      ['<p>two</p>', 2],
    ]);
    expect(result.current.conflict).toBe(true);
  });

  it('keeps the text and retries after a failed save', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue({ draft: { version: 2 }, preserved: null });
    const { result } = renderHook(() => useAutosave({ initialVersion: 1, save, delayMs: 10, retryMs: 500 }), { wrapper });
    act(() => result.current.change('<p>x</p>'));
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(result.current.state).toBe('error');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(save.mock.calls.map((c) => c[0])).toEqual(['<p>x</p>', '<p>x</p>']);
    expect(result.current.state).toBe('saved');
  });
});

describe('saveDraft', () => {
  it('sends If-Match and a device id, and reads X-Conflict-Preserved', async () => {
    api.routes[`PATCH /api/v1/cases/${CASE}/drafts/${D1}`] = () =>
      Response.json({ artifact_id: D1, case_id: CASE, template_key: 'BLANK', html: '<p>x</p>', version: 5, created_at: 'x', updated_at: 'x' }, { headers: { 'x-conflict-preserved': 'rev-9' } });
    const res = await saveDraft(CASE, D1, '<p>x</p>', 3);
    expect(res).toMatchObject({ draft: { version: 5 }, preserved: 'rev-9' });
    const call = api.calls[0]!;
    expect(call.headers.get('if-match')).toBe('"3"');
    expect(call.headers.get('x-device-id')).toMatch(/^web/);
    expect(call.body).toEqual({ html: '<p>x</p>' });
  });
});

describe('DraftsTab', () => {
  beforeEach(() => {
    api.routes[`GET /api/v1/cases/${CASE}/artifacts`] = () =>
      Response.json({
        items: [
          { artifact_id: 'scan', case_id: CASE, artifact_type: 'FIR_SCAN', template_key: null, processing_status: 'READY', processing_error: null, mime_type: 'application/pdf', page_count: 1, ocr_confidence: null, version: 1, created_at: 'x', updated_at: '2026-11-01T00:00:00Z' },
          { artifact_id: D1, case_id: CASE, artifact_type: 'VOICE_DICTATION_DRAFT', template_key: 'BAIL_PETITION', processing_status: null, processing_error: null, mime_type: null, page_count: null, ocr_confidence: null, version: 2, created_at: 'x', updated_at: '2026-11-08T00:00:00Z' },
        ],
      });
    api.routes['GET /api/v1/draft-templates'] = () =>
      Response.json({ items: [{ key: 'BAIL_PETITION', title_bn: 'জামিনের আবেদন', title_en: 'Bail petition', headings_bn: [], headings_en: ['Petitioner', 'Prayer'] }] });
  });

  it('lists only drafts, titled by template, linking to the editor', async () => {
    renderIn(<DraftsTab caseId={CASE} />);
    const link = await screen.findByRole('link', { name: /Bail petition/ });
    expect(link.getAttribute('href')).toBe(`/cases/${CASE}/drafts/${D1}`);
    expect(screen.getAllByRole('link')).toHaveLength(1); // the scanned FIR is not a draft
  });

  it('creates a draft from a template in the page language and opens it', async () => {
    api.routes[`POST /api/v1/cases/${CASE}/drafts`] = () =>
      Response.json({ artifact_id: 'new', case_id: CASE, template_key: 'BAIL_PETITION', html: '<h1>Bail petition</h1>', version: 1, created_at: 'x', updated_at: 'x' }, { status: 201 });
    renderIn(<DraftsTab caseId={CASE} />);
    await userEvent.click(screen.getByRole('button', { name: en.drafts.new }));
    await userEvent.click(await screen.findByRole('button', { name: /Bail petition.*Petitioner · Prayer/ }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/cases/${CASE}/drafts/new`));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ template_key: 'BAIL_PETITION', language: 'EN' });
  });
});

describe('DraftEditor', () => {
  it('renders the draft, offers formatting, and shows dictation as coming', async () => {
    renderIn(<DraftEditor caseId={CASE} draft={{ artifact_id: D1, case_id: CASE, template_key: 'BLANK', html: '<h1>Bench notes</h1><p>Hearing</p>', version: 1, created_at: 'x', updated_at: 'x' }} />);
    const box = await screen.findByRole('textbox', { name: en.drafts.editorLabel });
    await waitFor(() => expect(box.querySelector('h1')?.textContent).toBe('Bench notes'));
    expect(screen.getByRole('toolbar', { name: en.drafts.toolbar.label })).toBeTruthy();
    expect(screen.getByRole('button', { name: en.drafts.toolbar.micSoon }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(en.drafts.save.saved);
  });
});
