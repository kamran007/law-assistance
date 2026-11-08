import { defineRouting } from 'next-intl/routing';

/**
 * Bangla first (App Flow §2). The locale is always in the URL so the public law library pages
 * are cacheable and indexable per language.
 */
export const routing = defineRouting({
  locales: ['bn', 'en'],
  defaultLocale: 'bn',
  localePrefix: 'always',
});

export type Locale = (typeof routing.locales)[number];
