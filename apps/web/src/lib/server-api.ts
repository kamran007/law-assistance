import { createApiClient, isProblem, type paths } from '@lawassist/contracts';

/**
 * Typed API client for server components (public law library). Next.js caches these fetches for
 * `revalidate` seconds (ISR), so the CDN serves library pages without hitting the API each time.
 * `API_INTERNAL_URL` lets the web server reach the API on a private address in deployments.
 */
export function serverApi(revalidate: number) {
  const baseUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
  return createApiClient({
    baseUrl,
    fetch: (input, init) => fetch(input, { ...init, next: { revalidate } } as RequestInit),
  });
}

/** Library pages revalidate hourly; the nightly sync is the only writer. */
export const LIBRARY_REVALIDATE_S = 3600;

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
export type StatuteList = Json<paths['/api/v1/statutes']['get']['responses'][200]>;
export type StatuteDetail = Json<paths['/api/v1/statutes/{act_id}']['get']['responses'][200]>;
export type SectionDetail = Json<paths['/api/v1/statutes/{act_id}/sections/{sec}']['get']['responses'][200]>;
export type JudgmentList = Json<paths['/api/v1/judgments']['get']['responses'][200]>;
export type JudgmentDetail = Json<paths['/api/v1/judgments/{judgment_id}']['get']['responses'][200]>;

/** Judgment text language → the lang attribute (MIXED pages are mostly English with Bangla quotes). */
export const judgmentLang = (l: 'EN' | 'BN' | 'MIXED') => (l === 'BN' ? 'bn' : 'en');

/**
 * Data, `null` when the thing doesn't exist, or throws for anything else (the page shows its error
 * state). A malformed id in the URL (API 422, e.g. an impossible section number) is "not found" too.
 */
export async function dataOrNull<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T | null> {
  const { data, error, response } = await call;
  if (data !== undefined) return data;
  if (response.status === 404 || response.status === 422 || (isProblem(error) && (error.status === 404 || error.status === 422))) return null;
  throw new Error(`API ${response.status}`);
}

/** Title in the page language when the Act has one, else the official title. */
export const actTitle = (a: { title: string; title_en: string | null; title_bn: string | null }, locale: string) =>
  (locale === 'bn' ? a.title_bn : a.title_en) ?? a.title;
