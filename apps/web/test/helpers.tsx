import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import bn from '../messages/bn.json';
import en from '../messages/en.json';

export { bn, en };

export type Handler = (req: Request, url: URL) => Response | Promise<Response>;
export interface ApiStub {
  routes: Record<string, Handler>;
  calls: { method: string; path: string; body: unknown; headers: Headers }[];
}

/**
 * Stubs global fetch with a tiny router: keys are "METHOD /path" (path params as literal ids).
 * Requests go through the real typed client, so paths, bodies and headers are what the app sends.
 */
export function stubApi(): ApiStub {
  const stub: ApiStub = { routes: {}, calls: [] };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.clone().text();
    stub.calls.push({ method: req.method, path: url.pathname, body: text ? JSON.parse(text) : null, headers: req.headers });
    const h = stub.routes[`${req.method} ${url.pathname}`];
    return h ? h(req, url) : problem(404, 'NOT_FOUND');
  });
  return stub;
}

export const problem = (status: number, code: string) => Response.json({ type: 'x', title: code, status, code }, { status });

export function renderIn(ui: ReactNode, locale: 'bn' | 'en' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : bn} timeZone="Asia/Dhaka">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}
