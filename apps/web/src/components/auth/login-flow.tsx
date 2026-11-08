'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Field } from '@/components/field';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';
import { api, unwrap } from '@/lib/api';
import { startSession } from '@/lib/auth/session';
import { errorKey, safeNext, type ErrorKey } from '@/lib/problem';

/** Set once the visitor has picked a language (a per-browser convenience, not state that matters). */
export const LANGUAGE_CHOSEN_KEY = 'la.languageChosen';

type Step =
  | { kind: 'contact' }
  | { kind: 'otp'; challengeId: string; channel: 'SMS' | 'EMAIL'; delivery: 'SENT' | 'DEV_CONSOLE'; resendAt: number };

const noSubscribe = () => () => undefined;

function languageChosen(): boolean {
  try {
    return localStorage.getItem(LANGUAGE_CHOSEN_KEY) === '1';
  } catch {
    return true; // storage blocked: don't ask on every visit
  }
}

/** App Flow §3: language picker → phone or email → one-time code → profile setup or home. */
export function LoginFlow({ next }: { next?: string | null }) {
  const t = useTranslations('auth');
  const te = useTranslations('errors');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [step, setStep] = useState<Step>({ kind: 'contact' });
  const [contact, setContact] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // localStorage is only readable in the browser; the server render skips the picker.
  const storedChoice = useSyncExternalStore(noSubscribe, languageChosen, () => true);
  const [picked, setPicked] = useState(false);

  // Resend countdown.
  useEffect(() => {
    if (step.kind !== 'otp') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [step]);

  const apiLanguage = locale === 'en' ? 'EN' : 'BN';

  const chooseLanguage = (l: Locale) => {
    try {
      localStorage.setItem(LANGUAGE_CHOSEN_KEY, '1');
    } catch {
      /* storage blocked */
    }
    setPicked(true);
    if (l !== locale) router.replace({ pathname, query: next ? { next } : {} }, { locale: l });
  };

  const requestCode = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await unwrap(api.POST('/api/v1/auth/otp/request', { body: { contact: contact.trim(), language: apiLanguage } }));
      setCode('');
      setStep({ kind: 'otp', challengeId: data.challenge_id, channel: data.channel, delivery: data.delivery, resendAt: Date.now() + data.resend_after_s * 1000 });
      setNow(Date.now());
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'otp') return;
    setBusy(true);
    setError(null);
    try {
      const data = await unwrap(
        api.POST('/api/v1/auth/otp/verify', { body: { challenge_id: step.challengeId, code: code.trim(), language: apiLanguage, client: 'web' } }),
      );
      startSession(data);
      const target = safeNext(next);
      // The account's saved language wins over the page it signed in from.
      const userLocale = data.user.preferred_language.toLowerCase() as Locale;
      const destination = data.is_new_user || !data.user.profile_complete ? { pathname: '/onboarding', query: target === '/' ? {} : { next: target } } : target;
      router.replace(destination, { locale: routing.locales.includes(userLocale) ? userLocale : locale });
    } catch (err) {
      setError(errorKey(err));
      setBusy(false);
    }
  };

  const errorBox = error && (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {te(error)}
    </p>
  );

  if (step.kind === 'contact' && !storedChoice && !picked) {
    return (
      <section aria-labelledby="lang-title" className="space-y-6">
        <h1 id="lang-title" className="text-2xl font-semibold">
          {t('chooseLanguage')}
        </h1>
        <div className="grid gap-3 sm:grid-cols-2">
          {routing.locales.map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              onClick={() => chooseLanguage(l)}
              className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-6 py-8 text-xl font-semibold hover:border-brand-600 focus-visible:outline-2 focus-visible:outline-brand-600"
            >
              {l === 'bn' ? 'বাংলা' : 'English'}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (step.kind === 'contact') {
    return (
      <form onSubmit={requestCode} className="space-y-5" noValidate>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-[var(--muted)]">{t('subtitle')}</p>
        </div>
        <Field
          label={t('contactLabel')}
          hint={t('contactHint')}
          name="contact"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          autoComplete="username"
          inputMode="email"
          required
          placeholder={t('contactPlaceholder')}
        />
        {errorBox}
        <button type="submit" disabled={busy || contact.trim().length < 3} className="w-full rounded-lg bg-brand-600 px-4 py-2.5 font-medium text-white disabled:opacity-50">
          {busy ? t('sending') : t('sendCode')}
        </button>
      </form>
    );
  }

  const wait = Math.max(0, Math.ceil((step.resendAt - now) / 1000));
  return (
    <form onSubmit={verify} className="space-y-5" noValidate>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('otpTitle')}</h1>
        {step.delivery === 'DEV_CONSOLE' ? (
          <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {t('otpDevConsole')}
          </p>
        ) : (
          <p className="text-[var(--muted)]">{t(step.channel === 'SMS' ? 'otpSentSms' : 'otpSentEmail', { contact: contact.trim() })}</p>
        )}
      </div>
      <Field
        label={t('otpLabel')}
        name="code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
        required
        autoFocus
        className="text-center text-2xl tracking-[0.5em]"
      />
      {errorBox}
      <button type="submit" disabled={busy || code.trim().length !== 6} className="w-full rounded-lg bg-brand-600 px-4 py-2.5 font-medium text-white disabled:opacity-50">
        {busy ? t('verifying') : t('verify')}
      </button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={() => (setError(null), setStep({ kind: 'contact' }))} className="text-brand-700 underline">
          {t('changeContact')}
        </button>
        <button type="button" onClick={() => void requestCode()} disabled={busy || wait > 0} className="text-brand-700 underline disabled:text-[var(--muted)] disabled:no-underline">
          {wait > 0 ? t('resendIn', { seconds: wait }) : t('resend')}
        </button>
      </div>
    </form>
  );
}
