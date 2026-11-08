import { InvalidInputError } from '../app/application-error.js';
import { SOURCE_APPLICATIONS } from '../agents/source-applications.js';
import { CONVERSATION_LAUNCHER_APPLICATIONS } from '../system/runtime-settings.js';
import { requiredString, uniqueTextArray } from '../validation/values.js';
import { isLoopbackAddress } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// Whether the console offers to open recorded sessions (src/agent-kits/session-offers.js).
// A read like any other: it plans links and opens nothing.
//   GET /api/session-launch/offers?session=<sourceApplication>:<sessionId>&session=…
const OFFERS_PATH = '/api/session-launch/offers';
// A new session in a connected client's CLI (src/agent-kits/new-sessions.js).
// Both are POSTs from this computer only: finding out which CLIs are installed
// may download the launcher and start the person's login shell or WSL, and
// opening starts a terminal. A LAN console gets 403 for both and offers copy.
//   POST …/new-session/ways { clients }   which of them can open here; opens nothing.
//   POST …/new-session { client, prompt } the person's click: opens a terminal.
const NEW_SESSION_PATH = '/api/session-launch/new-session';
const WAYS_PATH = '/api/session-launch/new-session/ways';
// One knowledge item's evidence; each session may start the launcher once.
const MAX_SESSIONS = 20;
const MAX_SESSION_ID = 512;
const MAX_CLIENTS = 32;
const APPLICATIONS = new Set([...SOURCE_APPLICATIONS, ...CONVERSATION_LAUNCHER_APPLICATIONS]);

export async function handleSessionLaunchRequest({ request, response, url, system }) {
  if ((url.pathname === NEW_SESSION_PATH || url.pathname === WAYS_PATH) && system?.newSessionWays) {
    return await newSession({ request, response, url, system });
  }
  if (!system?.sessionLaunchOffers || url.pathname !== OFFERS_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  sendJson(response, 200, await system.sessionLaunchOffers(sessionsOf(url.searchParams.getAll('session'))));
  return true;
}

async function newSession({ request, response, url, system }) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!isLoopbackAddress(request.socket?.remoteAddress)) {
    sendJson(response, 403, { error: 'A new session can only be opened on this computer' });
    return true;
  }
  const body = await readJson(request);
  if (url.pathname === WAYS_PATH) {
    sendJson(response, 200, await system.newSessionWays(uniqueTextArray(body?.clients, 'clients', MAX_CLIENTS)));
    return true;
  }
  const answer = await system.openNewSession({ client: body?.client, prompt: body?.prompt });
  sendJson(response, answer.status === 'launch_requested' ? 200 : answer.status === 'refused' ? 400 : 503, answer);
  return true;
}

function sessionsOf(values) {
  return uniqueTextArray(values, 'session', MAX_SESSIONS).map((value) => {
    const separator = value.indexOf(':');
    const sourceApplication = value.slice(0, separator);
    if (separator < 1 || !APPLICATIONS.has(sourceApplication)) {
      throw new InvalidInputError('session must be <sourceApplication>:<sessionId> with a known source application');
    }
    return { sourceApplication, sessionId: requiredString(value.slice(separator + 1), 'session id', MAX_SESSION_ID) };
  });
}
