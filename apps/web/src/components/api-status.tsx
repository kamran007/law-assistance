'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { api, unwrap } from '@/lib/api';

/** Shows that the typed client reaches the API: number of Acts in the law library. */
export function ApiStatus() {
  const t = useTranslations('home');
  const { data, isError, isPending } = useQuery({
    queryKey: ['statutes', 'count'],
    queryFn: async () => {
      return (await unwrap(api.GET('/api/v1/statutes', { params: { query: { limit: 1 } } }))).total;
    },
  });
  const text = isPending ? t('apiChecking') : isError ? t('apiDown') : t('apiUp', { count: data });
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-[var(--muted)]">
      <span aria-hidden className={`size-2 rounded-full ${isPending ? 'bg-gray-400' : isError ? 'bg-red-500' : 'bg-emerald-500'}`} />
      {text}
    </p>
  );
}
