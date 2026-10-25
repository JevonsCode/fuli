import { humanReviewToken } from '../graphiti/human-review-channel.js';
import { CODES_PATH, SIGN_IN_PATH, SIGN_IN_TOKEN_HEADER } from './http.js';

const CODE_REQUEST_TIMEOUT_MS = 5_000;

// The one-time sign-in URL `fuli open` hands the browser (rec#11 D-61): the
// running console issues a code for the data directory's human-review token
// (sent in a header), and the URL carries that code alone. next: the console
// path to land on, checked by the console. Throws when the console cannot
// issue a code (an older console, no human-review channel, a refusal). The
// URL is for the browser only: never print or log it.
export async function consoleSignInUrl({ consoleUrl, dataDir, next = null, fetchImpl = fetch,
  readToken = humanReviewToken }) {
  const response = await fetchImpl(new URL(CODES_PATH, consoleUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGN_IN_TOKEN_HEADER]: readToken(dataDir) },
    body: JSON.stringify(next ? { next } : {}),
    signal: AbortSignal.timeout(CODE_REQUEST_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload?.code !== 'string') {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `the console answered HTTP ${response.status}`);
  }
  const url = new URL(SIGN_IN_PATH, consoleUrl);
  url.searchParams.set('code', payload.code);
  return url.href;
}
