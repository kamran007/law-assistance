import type { Metadata, Viewport } from 'next';
import { Noto_Sans, Noto_Sans_Bengali } from 'next/font/google';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AccountMenu } from '@/components/auth/account-menu';
import { AuthProvider } from '@/components/auth/auth-provider';
import { VerificationBanner } from '@/components/auth/verification-banner';
import { LanguageSwitcher } from '@/components/language-switcher';
import { Providers } from '@/components/providers';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import '../globals.css';

const bengali = Noto_Sans_Bengali({ subsets: ['bengali'], variable: '--font-bengali', display: 'swap' });
const latin = Noto_Sans({ subsets: ['latin'], variable: '--font-latin', display: 'swap' });

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: { default: t('title'), template: `%s · ${t('title')}` },
    description: t('description'),
    alternates: { languages: { bn: '/bn', en: '/en' } },
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('nav');

  return (
    <html lang={locale} className={`${bengali.variable} ${latin.variable}`}>
      <body className="min-h-dvh font-sans antialiased">
        <NextIntlClientProvider>
          <Providers>
            <AuthProvider>
            <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2">
              {t('skip')}
            </a>
            <header className="border-b border-[var(--border)]">
              <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
                <Link href="/" className="text-lg font-semibold text-brand-700">
                  {t('brand')}
                </Link>
                <div className="flex items-center gap-3">
                  <LanguageSwitcher />
                  <AccountMenu />
                </div>
              </div>
            </header>
            <VerificationBanner />
            <main id="main" className="mx-auto max-w-6xl px-4 py-8">
              {children}
            </main>
            </AuthProvider>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
