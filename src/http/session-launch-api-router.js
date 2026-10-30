import { InvalidInputError } from '../app/application-error.js';
import { SOURCE_APPLICATIONS } from '../agents/source-applications.js';
import { CONVERSATION_LAUNCHER_APPLICATIONS } from '../system/runtime-settings.js';
import { requiredString, uniqueTextArray } from '../validation/values.js';
import { sendJson } from './response.js';

// Whether the console offers to open recorded sessions (src/agent-kits/session-offers.js).
// A read like any other: it plans links and opens nothing.
//   GET /api/session-launch/offers?session=<sourceApplication>:<sessionId>&session=…
const OFFERS_PATH = '/api/session-launch/offers';
// One knowledge item's evidence; each session may start the launcher once.
const MAX_SESSIONS = 20;
const MAX_SESSION_ID = 512;
const APPLICATIONS = new Set([...SOURCE_APPLICATIONS, ...CONVERSATION_LAUNCHER_APPLICATIONS]);

export async function handleSessionLaunchRequest({ request, response, url, system }) {
  if (!system?.sessionLaunchOffers || url.pathname !== OFFERS_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  sendJson(response, 200, await system.sessionLaunchOffers(sessionsOf(url.searchParams.getAll('session'))));
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
