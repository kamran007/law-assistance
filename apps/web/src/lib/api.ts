import { createApiClient } from '@lawassist/contracts';
import { API_URL } from './env';
import { session } from './session';

/** Typed client for the browser; the language follows the page's <html lang>. */
export const api = createApiClient({
  baseUrl: API_URL,
  getAccessToken: () => session.token,
  getLanguage: () => (typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'bn'),
});
