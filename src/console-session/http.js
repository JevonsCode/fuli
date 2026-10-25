import { createHash, timingSafeEqual } from 'node:crypto';

import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';
import { CODE_TTL_MS } from './session.js';
import { consoleNextPath } from './next-path.js';

export const SIGN_IN_PAGE_PATH = '/auth/console';
export const CODES_PATH = '/api/console-session/codes';
const REDEEM_PATH = '/api/console-session/sign-in';
export const SIGN_IN_TOKEN_HEADER = 'x-fuli-console-sign-in';
export const SESSION_HEADER = 'x-fuli-console-session';

// The routes of a console sign-in (rec#11 D-61). signIn: { session
// (session.js), launchers (launcher-file.js), readToken: the data directory's
// human-review token }.
//
// POST /api/console-session/codes: `fuli open` asks the running console for a
// sign-in, with the data directory's human-review token in a header (never a
// URL). Loopback only. The token shows the caller can read the data directory,
// which is the same-account limit the console already has; a caller without it
// gets 403. The landing path (`next`) is checked here and kept with the code.
// The answer is the path of an owner-only launcher file holding the code;
// the code itself is never answered, printed or put on a command line.
//
// The launcher sends the browser to /auth/console#code=…, the console's own
// sign-in page (the web console). The fragment never reaches a server.
//
// POST /api/console-session/sign-in: that page redeems the code once with a
// same-origin request; another origin's request is refused by the request
// policy before this route, and a cross-site or same-site one here. The answer
// sets an HttpOnly, SameSite=Strict, Path=/ cookie and returns the landing
// path and the session token, which the page keeps in its origin's storage
// and sends as x-fuli-console-session. A cookie reaches every port of the
// host; the token does not leave this origin. Gated routes need both. Neither
// the code, the cookie nor the token is ever logged.
//
// A code in a URL's query is not how a sign-in works: any request naming one
// burns it first (discardUrlCode), before the request policy, so a code that
// reached a link or a subresource cannot be used afterwards.
export async function handleConsoleSessionRequest({ request, response, signIn, authority }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === CODES_PATH) return issueSignIn({ request, response, signIn, authority });
  if (url.pathname === REDEEM_PATH) return redeem({ request, response, signIn, authority });
  if (url.pathname === SIGN_IN_PAGE_PATH && url.searchParams.has('code')) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(URL_CODE_REFUSED);
    return true;
  }
  return false;
}

// Burns a code named in a URL, whatever else happens to the request.
export function discardUrlCode(request, signIn) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname !== SIGN_IN_PAGE_PATH || !signIn?.session) return;
  for (const code of url.searchParams.getAll('code')) {
    signIn.session.discard(code);
    signIn.launchers?.remove(code);
  }
}

// Whether this request carries both credentials of this launch's session.
export function hasConsoleSession(request, session, authority) {
  if (!session) return false;
  const name = consoleCookieName(authority);
  const cookies = String(request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
  const token = request.headers[SESSION_HEADER];
  return cookies.some(cookie => session.isSignedIn({ cookie, token }));
}

// Cookies are shared by every port of a host, so each console port has its own name.
function consoleCookieName(authority) {
  const port = String(authority ?? '').split(':')[1] ?? '80';
  return `fuli_console_${port}`;
}

async function issueSignIn({ request, response, signIn, authority }) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'A console sign-in is requested only on this computer')) return true;
  const expected = signIn?.session && signIn.launchers ? signInToken(signIn.readToken) : null;
  if (!expected) {
    sendJson(response, 503, { error: 'Signing in to the console needs a local FULI installation with its human-review channel' });
    return true;
  }
  if (!sameToken(request.headers[SIGN_IN_TOKEN_HEADER], expected)) {
    sendJson(response, 403, { error: 'Only fuli open on this computer can sign in to the console', code: 'console_sign_in_refused' });
    return true;
  }
  const body = await readJson(request);
  const code = signIn.session.issueCode(consoleNextPath(body?.next));
  sendJson(response, 200, { launcherPath: signIn.launchers.write(code, `http://${authority}`), expiresInMs: CODE_TTL_MS });
  return true;
}

async function redeem({ request, response, signIn, authority }) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'The console is signed in to only on the computer running FULI')) return true;
  if (!signIn?.session) {
    sendJson(response, 503, { error: 'Signing in to the console needs a local FULI installation' });
    return true;
  }
  const code = (await readJson(request))?.code;
  if (!['', 'same-origin'].includes(fetchSite(request))) {
    signIn.session.discard(code);
    signIn.launchers?.remove(code);
    sendJson(response, 403, { error: 'A console sign-in is accepted only from the console\'s own page', code: 'console_sign_in_refused' });
    return true;
  }
  const redeemed = signIn.session.redeem(code);
  signIn.launchers?.remove(code);
  if (!redeemed) {
    sendJson(response, 401, { error: 'This sign-in is used up or expired. Run fuli open again.', code: 'console_sign_in_expired' });
    return true;
  }
  const { cookie, token } = signIn.session.credentials();
  response.setHeader('set-cookie', `${consoleCookieName(authority)}=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
  sendJson(response, 200, { next: redeemed.next, token });
  return true;
}

function signInToken(readToken) {
  try {
    return readToken?.() || null;
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

const URL_CODE_REFUSED = 'A sign-in code in a link is not accepted, and this one is now discarded. Run fuli open in a terminal on the computer running FULI.\n'
  + '链接里的登录码不会被接受，这个已作废。请在运行 FULI 的电脑上，在终端运行 fuli open。';
