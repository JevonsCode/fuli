import { createHash, timingSafeEqual } from 'node:crypto';

import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';
import { CODE_TTL_MS } from './session.js';
import { consoleNextPath } from './next-path.js';

export const SIGN_IN_PATH = '/auth/console';
export const CODES_PATH = '/api/console-session/codes';
export const SIGN_IN_TOKEN_HEADER = 'x-fuli-console-sign-in';

// The two routes of a console sign-in (rec#11 D-61).
//
// POST /api/console-session/codes: `fuli open` asks the running console for a
// one-time code, with the data directory's human-review token in a header
// (never a URL). Loopback only. The token shows the caller can read the data
// directory, which is the same-account limit the console already has; a
// caller without it gets 403 and no code. The landing path (`next`) is
// checked here and kept with the code, so the sign-in URL carries the code
// alone and no URL can choose where a sign-in lands.
//
// GET /auth/console?code=…: the browser redeems the code once. A redemption
// that comes from another site, or from another site on this computer
// (Sec-Fetch-Site cross-site or same-site), is refused and the code is
// burned: a code that reached a page is treated as leaked, and nobody can sign a
// person's browser in from a link. A browser opened by `fuli open` sends
// "none". Success sets an HttpOnly, SameSite=Strict, Path=/ cookie and
// answers 303 to the kept path, with no-store and no referrer, so the code
// leaves the address bar and the history entry. Neither the code nor the
// cookie is ever logged.
export async function handleConsoleSessionRequest({ request, response, session, readSignInToken, authority }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === CODES_PATH) return issueCode({ request, response, session, readSignInToken });
  if (url.pathname !== SIGN_IN_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.method !== 'GET') return refusePage(response, 405, 'method');
  if (!session) return refusePage(response, 503, 'unavailable');
  if (refuseRemoteDecision(request, response, 'The console is signed in to only on this computer')) return true;
  const code = url.searchParams.get('code');
  if (!['', 'none', 'same-origin'].includes(fetchSite(request))) {
    session.discard(code);
    return refusePage(response, 403, 'crossSite');
  }
  const redeemed = session.redeem(code);
  if (!redeemed) return refusePage(response, 401, 'invalid');
  response.writeHead(303, {
    location: redeemed.next,
    'set-cookie': `${consoleCookieName(authority)}=${session.cookieValue()}; HttpOnly; SameSite=Strict; Path=/`,
    'content-type': 'text/plain; charset=utf-8'
  });
  response.end();
  return true;
}

// Whether this request carries the console session of this launch.
export function hasConsoleSession(request, session, authority) {
  if (!session) return false;
  const name = consoleCookieName(authority);
  const values = String(request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
  return values.some(value => session.isValid(value));
}

// Cookies are shared by every port of a host, so each console port has its own.
function consoleCookieName(authority) {
  const port = String(authority ?? '').split(':')[1] ?? '80';
  return `fuli_console_${port}`;
}

async function issueCode({ request, response, session, readSignInToken }) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'A console sign-in is requested only on this computer')) return true;
  const expected = session ? signInToken(readSignInToken) : null;
  if (!expected) {
    sendJson(response, 503, { error: 'Signing in to the console needs a local FULI installation with its human-review channel' });
    return true;
  }
  if (!sameToken(request.headers[SIGN_IN_TOKEN_HEADER], expected)) {
    sendJson(response, 403, { error: 'Only fuli open on this computer can sign in to the console', code: 'console_sign_in_refused' });
    return true;
  }
  const body = await readJson(request);
  const next = consoleNextPath(body?.next);
  sendJson(response, 200, { code: session.issueCode(next), expiresInMs: CODE_TTL_MS });
  return true;
}

function signInToken(readSignInToken) {
  try {
    return readSignInToken?.() || null;
  } catch {
    return null;
  }
}

function sameToken(offered, expected) {
  if (typeof offered !== 'string' || !offered) return false;
  const digest = (text) => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(offered), digest(expected));
}

function fetchSite(request) {
  return String(request.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
}

const REFUSALS = {
  method: 'Method not allowed.',
  unavailable: 'This console cannot sign in: it needs a local FULI installation.\n此控制台无法登录：需要本机安装的 FULI。',
  crossSite: 'This sign-in link was opened from another site, so it was discarded. Run fuli open in a terminal on this computer.\n这个登录链接是从其他网站打开的，已作废。请在这台电脑的终端运行 fuli open。',
  invalid: 'This sign-in link is used up or expired. Run fuli open in a terminal on this computer.\n这个登录链接已用过或已过期。请在这台电脑的终端运行 fuli open。'
};

function refusePage(response, status, reason) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(REFUSALS[reason]);
  return true;
}
