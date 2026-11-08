'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Field } from '@/components/field';
import { api, unwrap } from '@/lib/api';
import { authStore, type Me } from '@/lib/auth/store';
import { errorKey, safeNext, type ErrorKey } from '@/lib/problem';

type Role = 'CITIZEN' | 'LAWYER' | 'JUDGE';
const ROLES: Role[] = ['CITIZEN', 'LAWYER', 'JUDGE'];

/**
 * Profile Setup (App Flow §3): name and role. Lawyers and Judges enter their Bar Council
 * enrollment number or Judicial ID; they keep Citizen features until an admin verifies it.
 * A credential already submitted (PENDING / VERIFIED) locks the role.
 */
export function OnboardingForm({ user, next }: { user: Me; next?: string | null }) {
  const t = useTranslations('onboarding');
  const te = useTranslations('errors');
  const router = useRouter();
  const roleLocked = user.verification_status === 'PENDING' || user.verification_status === 'VERIFIED';
  const [fullName, setFullName] = useState(user.full_name);
  const [role, setRole] = useState<Role>(user.requested_role === 'ADMIN' ? 'CITIZEN' : user.requested_role);
  const [credential, setCredential] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [busy, setBusy] = useState(false);

  const needsCredential = role !== 'CITIZEN' && !roleLocked;
  const valid = fullName.trim().length >= 2 && (!needsCredential || credential.trim().length >= 3);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let me = user;
      if (fullName.trim() !== user.full_name) {
        me = await unwrap(api.PATCH('/api/v1/me', { body: { full_name: fullName.trim() } }));
      }
      if (needsCredential) {
        me = await unwrap(api.POST('/api/v1/me/credential', { body: { requested_role: role, credential: credential.trim() } }));
      }
      authStore.setUser(me);
      router.replace(safeNext(next));
    } catch (err) {
      setError(errorKey(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-[var(--muted)]">{t('subtitle')}</p>
      </div>
      <Field label={t('nameLabel')} name="full_name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" maxLength={200} required />
      <fieldset className="space-y-2" disabled={roleLocked}>
        <legend className="text-sm font-medium">{t('roleLabel')}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {ROLES.map((r) => (
            <label
              key={r}
              className={`cursor-pointer rounded-lg border px-3 py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-600 ${role === r ? 'border-brand-600 bg-brand-50 dark:bg-brand-900' : 'border-[var(--border)]'}`}
            >
              <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="sr-only" />
              <span className="block font-medium">{t(`roles.${r}.title`)}</span>
              <span className="block text-xs text-[var(--muted)]">{t(`roles.${r}.body`)}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)]">{t('roleLocked')}</p>
      </fieldset>
      {needsCredential && (
        <Field
          label={t(role === 'LAWYER' ? 'barCouncilLabel' : 'judicialIdLabel')}
          hint={t('credentialHint')}
          name="credential"
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          maxLength={50}
          required
        />
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {te(error)}
        </p>
      )}
      <button type="submit" disabled={busy || !valid} className="w-full rounded-lg bg-brand-600 px-4 py-2.5 font-medium text-white disabled:opacity-50">
        {busy ? t('saving') : t('continue')}
      </button>
    </form>
  );
}
