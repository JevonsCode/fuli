import { sendJson } from './response.js';
import { readSessionRecords } from '../graphiti/session-records.js';

// The console's list of what one host session recorded (rec#5 C6). The link
// grants nothing: the Provider authorizes the read for the person.
export async function handleSessionRecordsRequest({ request, response, url, app }) {
  if (url.pathname !== '/api/session-records' || request.method !== 'GET') return false;
  sendJson(response, 200, await readSessionRecords(app, {
    personalSpaceId: url.searchParams.get('personalSpaceId'),
    sourceApplication: url.searchParams.get('sourceApplication'),
    sessionId: url.searchParams.get('sessionId') }));
  return true;
}
