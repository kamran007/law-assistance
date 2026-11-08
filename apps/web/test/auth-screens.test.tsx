import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bn from '../messages/bn.json';
import en from '../messages/en.json';

/** WEB-02 screens in jsdom: API calls go through the real typed client to a stubbed fetch. */
const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: '/login' }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
  usePathname: () => nav.pathname,
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const { LoginFlow, LANGUAGE_CHOSEN_KEY } = await import('@/components/auth/login-flow');
const { OnboardingForm } = await import('@/components/auth/onboarding-form');
const { VerificationBanner } = await import('@/components/auth/verification-banner');
const { authStore } = await import('@/lib/auth/store');
type Me = import('@/lib/auth/store').Me;

const user = (over: Partial<Me> = {}): Me => ({
  user_id: 'u1',
  full_name: '',
  contact: '+8801711000000',
  role: 'CITIZEN',
  requested_role: 'CITIZEN',
  verification_status: 'NOT_REQUIRED',
  preferred_language: 'BN',
  profile_complete: false,
  ...over,
});

type Handler = (req: Request) => Response | Promise<Response>;
let routes: Record<string, Handler>;
const calls: { method: string; path: string; body: unknown }[] = [];

beforeEach(() => {
  routes = {};
  calls.length = 0;
  nav.replace.mockReset();
  localStorage.clear();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    const text = await req.clone().text();
    calls.push({ method: req.method, path, body: text ? JSON.parse(text) : null });
    const h = routes[`${req.method} ${path}`];
    return h ? h(req) : Response.json({ type: 'x', title: 'Not found', status: 404, code: 'NOT_FOUND' }, { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  authStore.clear();
});

const renderIn = (ui: ReactNode, locale: 'bn' | 'en' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : bn} timeZone="Asia/Dhaka">
      {ui}
    </NextIntlClientProvider>,
  );
const problem = (status: number, code: string) => Response.json({ type: 'x', title: code, status, code }, { status });
const sessionFor = (u: Me, isNew: boolean) => Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 900, refresh_expires_at: 'x', is_new_user: isNew, user: u });

describe('LoginFlow', () => {
  it('asks for the language on the first visit and remembers it', async () => {
    renderIn(<LoginFlow />);
    expect(screen.getByRole('heading', { name: en.auth.chooseLanguage })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'বাংলা' }));
    expect(localStorage.getItem(LANGUAGE_CHOSEN_KEY)).toBe('1');
    expect(nav.replace).toHaveBeenCalledWith({ pathname: '/login', query: {} }, { locale: 'bn' });
  });

  it('new user: contact → code (Bangla digits) → session → profile setup, keeping `next`', async () => {
    localStorage.setItem(LANGUAGE_CHOSEN_KEY, '1');
    routes['POST /api/v1/auth/otp/request'] = () => Response.json({ challenge_id: '0190a000-0000-7000-8000-000000000001', channel: 'SMS', expires_in_s: 300, resend_after_s: 60 }, { status: 202 });
    routes['POST /api/v1/auth/otp/verify'] = () => sessionFor(user({ preferred_language: 'EN' }), true);
    renderIn(<LoginFlow next="/cases" />);

    await userEvent.type(screen.getByLabelText(en.auth.contactLabel), '01711000000');
    await userEvent.click(screen.getByRole('button', { name: en.auth.sendCode }));
    expect(await screen.findByRole('heading', { name: en.auth.otpTitle })).toBeTruthy();
    expect(screen.getByRole('button', { name: /resend in 60/i }).hasAttribute('disabled')).toBe(true);

    await userEvent.type(screen.getByLabelText(en.auth.otpLabel), '১২৩৪৫৬');
    await userEvent.click(screen.getByRole('button', { name: en.auth.verify }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());

    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/api/v1/auth/otp/request', { contact: '01711000000', language: 'EN' }],
      ['/api/v1/auth/otp/verify', { challenge_id: '0190a000-0000-7000-8000-000000000001', code: '১২৩৪৫৬', language: 'EN', client: 'web' }],
    ]);
    expect(nav.replace).toHaveBeenCalledWith({ pathname: '/onboarding', query: { next: '/cases' } }, { locale: 'en' });
    expect(authStore.accessToken).toBe('at');
  });

  it('returning user goes to `next` in their saved language; a crafted `next` goes home', async () => {
    localStorage.setItem(LANGUAGE_CHOSEN_KEY, '1');
    routes['POST /api/v1/auth/otp/request'] = () => Response.json({ challenge_id: '0190a000-0000-7000-8000-000000000002', channel: 'EMAIL', expires_in_s: 300, resend_after_s: 0 }, { status: 202 });
    routes['POST /api/v1/auth/otp/verify'] = () => sessionFor(user({ full_name: 'Rahim', profile_complete: true, preferred_language: 'BN' }), false);
    renderIn(<LoginFlow next="//evil.test" />);
    await userEvent.type(screen.getByLabelText(en.auth.contactLabel), 'r@example.com');
    await userEvent.click(screen.getByRole('button', { name: en.auth.sendCode }));
    await userEvent.type(await screen.findByLabelText(en.auth.otpLabel), '123456');
    await userEvent.click(screen.getByRole('button', { name: en.auth.verify }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/', { locale: 'bn' }));
  });

  it('shows the API error in the page language', async () => {
    localStorage.setItem(LANGUAGE_CHOSEN_KEY, '1');
    routes['POST /api/v1/auth/otp/request'] = () => problem(422, 'INVALID_CONTACT');
    renderIn(<LoginFlow />, 'bn');
    await userEvent.type(screen.getByLabelText(bn.auth.contactLabel), '123');
    await userEvent.click(screen.getByRole('button', { name: bn.auth.sendCode }));
    expect((await screen.findByRole('alert')).textContent).toBe(bn.errors.INVALID_CONTACT);
  });

  it('a wrong code keeps the user on the code step with a message', async () => {
    localStorage.setItem(LANGUAGE_CHOSEN_KEY, '1');
    routes['POST /api/v1/auth/otp/request'] = () => Response.json({ challenge_id: '0190a000-0000-7000-8000-000000000003', channel: 'SMS', expires_in_s: 300, resend_after_s: 60 }, { status: 202 });
    routes['POST /api/v1/auth/otp/verify'] = () => problem(400, 'OTP_INVALID');
    renderIn(<LoginFlow />);
    await userEvent.type(screen.getByLabelText(en.auth.contactLabel), '01711000000');
    await userEvent.click(screen.getByRole('button', { name: en.auth.sendCode }));
    await userEvent.type(await screen.findByLabelText(en.auth.otpLabel), '000000');
    await userEvent.click(screen.getByRole('button', { name: en.auth.verify }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.OTP_INVALID);
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe('OnboardingForm', () => {
  it('citizen: saves the name only', async () => {
    authStore.setSession('at', 900, user());
    routes['PATCH /api/v1/me'] = () => Response.json(user({ full_name: 'Rahim Uddin', profile_complete: true }));
    renderIn(<OnboardingForm user={user()} />);
    await userEvent.type(screen.getByLabelText(en.onboarding.nameLabel), 'Rahim Uddin');
    await userEvent.click(screen.getByRole('button', { name: en.onboarding.continue }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/'));
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([['PATCH', '/api/v1/me', { full_name: 'Rahim Uddin' }]]);
    expect(authStore.getState()).toMatchObject({ status: 'signedIn', user: { profile_complete: true } });
  });

  it('lawyer: name, then the Bar Council number for verification', async () => {
    authStore.setSession('at', 900, user());
    routes['PATCH /api/v1/me'] = () => Response.json(user({ full_name: 'Adv. Karim', profile_complete: true }));
    routes['POST /api/v1/me/credential'] = () => Response.json(user({ full_name: 'Adv. Karim', profile_complete: true, requested_role: 'LAWYER', verification_status: 'PENDING' }));
    renderIn(<OnboardingForm user={user()} next="/cases" />);
    await userEvent.type(screen.getByLabelText(en.onboarding.nameLabel), 'Adv. Karim');
    expect(screen.queryByLabelText(en.onboarding.barCouncilLabel)).toBeNull();
    await userEvent.click(screen.getByLabelText(new RegExp(en.onboarding.roles.LAWYER.title)));
    const submit = screen.getByRole('button', { name: en.onboarding.continue });
    expect(submit.hasAttribute('disabled')).toBe(true); // credential still missing
    await userEvent.type(screen.getByLabelText(en.onboarding.barCouncilLabel), 'BC/12345');
    await userEvent.click(submit);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/cases'));
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/api/v1/me', { full_name: 'Adv. Karim' }],
      ['/api/v1/me/credential', { requested_role: 'LAWYER', credential: 'BC/12345' }],
    ]);
  });
});

describe('VerificationBanner', () => {
  it('explains the pending verification to a Lawyer, and nothing for a Citizen', () => {
    authStore.setSession('at', 900, user({ requested_role: 'LAWYER', verification_status: 'PENDING', profile_complete: true }));
    const { unmount } = renderIn(<VerificationBanner />);
    expect(screen.getByRole('status').textContent).toBe(en.banner.pending.replace('{credential}', en.banner.barCouncil));
    unmount();
    authStore.setSession('at', 900, user({ profile_complete: true }));
    renderIn(<VerificationBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
