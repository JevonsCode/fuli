import { createHash, timingSafeEqual } from 'node:crypto';

import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';
import { CODE_TTL_MS } from './session.js';
import { consoleNextPath } from './next-path.js';

export const SIGN_IN_PAGE_PATH = '/auth/console';
export const CODES_PATH = '/api/console-session/codes';
const REDEEM_PATH = '/api/console-session/sign-in';
const OPEN_PATH = '/api/console-session/open';
export const SIGN_IN_TOKEN_HEADER = 'x-fuli-console-sign-in';
export const SESSION_HEADER = 'x-fuli-console-session';

// The routes of a console sign-in (rec#11 D-61). signIn: { session
// (session.js), launchers (launcher-file.js), readToken: the data directory's
// human-review token, openLauncher: opens a launcher file in this computer's
// browser }.
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
// POST /api/console-session/open: the console page's sign-in button (rec#11
// D-69), so signing in never needs a terminal. Loopback only, and only from
// the console's own page, as redeeming is. The console writes the launcher
// `fuli open` would get and opens it in this computer's browser itself; the
// answer holds neither the code nor the file's path, so a caller learns
// nothing it could redeem. The code reaches only the browser, through the
// owner-only file.
//
// A code in a URL's query is not how a sign-in works: any request naming one
// burns it first (discardUrlCode), before the request policy, so a code that
// reached a link or a subresource cannot be used afterwards.
export async function handleConsoleSessionRequest({ request, response, signIn, authority }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === CODES_PATH) return issueSignIn({ request, response, signIn, authority });
  if (url.pathname === REDEEM_PATH) return redeem({ request, response, signIn, authority });
  if (url.pathname === OPEN_PATH) return openFromPage({ request, response, signIn, authority });
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
  const launcher = writeLauncher(signIn, await readJson(request), authority, response);
  if (launcher) sendJson(response, 200, { launcherPath: launcher.path, expiresInMs: CODE_TTL_MS });
  return true;
}

async function openFromPage({ request, response, signIn, authority }) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'The console is signed in to only on the computer running FULI')) return true;
  if (!signIn?.session || !signIn.launchers || !signIn.openLauncher) {
    sendJson(response, 503, { error: 'Signing in to the console needs a local FULI installation' });
    return true;
  }
  if (!['', 'same-origin'].includes(fetchSite(request))) {
    sendJson(response, 403, { error: 'A console sign-in is opened only from the console\'s own page', code: 'console_sign_in_refused' });
    return true;
  }
  const launcher = writeLauncher(signIn, await readJson(request), authority, response);
  if (!launcher) return true;
  try {
    await signIn.openLauncher(launcher.path);
  } catch (error) {
    signIn.session.discard(launcher.code);
    signIn.launchers.remove(launcher.code);
    sendJson(response, 503, { error: error.message, code: 'console_sign_in_unavailable' });
    return true;
  }
  sendJson(response, 200, { status: 'opened', expiresInMs: CODE_TTL_MS });
  return true;
}

// Issues a code landing on body.next and writes its owner-only launcher, or
// answers why not and returns null. Fails closed: a code that could not be
// kept private is never usable.
function writeLauncher(signIn, body, authority, response) {
  const code = signIn.session.issueCode(consoleNextPath(body?.next));
  try {
    return { code, path: signIn.launchers.write(code, `http://${authority}`) };
  } catch (error) {
    signIn.session.discard(code);
    sendJson(response, 503, { error: error.message, code: 'console_sign_in_unavailable' });
    return null;
  }
}

// Whether a request carries the data directory's human-review token, as
// `fuli open` does to ask for a sign-in and `fuli peer` to change the LAN
// roundtable (rec#11 D-61). Like a sign-in it needs read access to the data
// directory, so it stands in for the console session only where a command
// line has no browser. A request without the header reads nothing.
export function hasSignInToken(request, signIn) {
  const offered = request.headers[SIGN_IN_TOKEN_HEADER];
  if (typeof offered !== 'string' || !offered || !signIn?.session) return false;
  const expected = signInToken(signIn.readToken);
  return Boolean(expected) && sameToken(offered, expected);
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
    sendJson(response, 401, { error: 'This sign-in is used up or expired. Choose Sign in on the console again.', code: 'console_sign_in_expired' });
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

const URL_CODE_REFUSED = 'A sign-in code in a link is not accepted, and this one is now discarded. Open the console on the computer running FULI and choose Sign in.\n'
  + '链接里的登录码不会被接受，这个已作废。请在运行 FULI 的电脑上打开控制台，点「登录」。';
