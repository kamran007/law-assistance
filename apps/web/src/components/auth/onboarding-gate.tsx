'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { safeNext } from '@/lib/problem';
import { OnboardingForm } from './onboarding-form';
import { RequireAuth } from './require-auth';

/** Profile Setup for signed-in users whose profile is incomplete; others go on to `next`. */
export function OnboardingGate({ next }: { next: string | null }) {
  return <RequireAuth allowIncompleteProfile>{(user) => (user.profile_complete ? <Done next={next} /> : <OnboardingForm user={user} next={next} />)}</RequireAuth>;
}

function Done({ next }: { next: string | null }) {
  const router = useRouter();
  useEffect(() => router.replace(safeNext(next)), [router, next]);
  return null;
}
