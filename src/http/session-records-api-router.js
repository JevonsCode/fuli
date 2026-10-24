import { sendJson } from './response.js';
import { ownerReadsUnavailable } from './knowledge-item-api-router.js';
import { readSessionRecords } from '../graphiti/session-records.js';

// The console's list of what one host session recorded (rec#5 C6). The link
// grants nothing: the Provider authorizes the read for the person, who sees
// every FLA's items there, so it goes through ownerReads, the console's
// human-review port.
export async function handleSessionRecordsRequest({ request, response, url, app, ownerReads = null }) {
  if (url.pathname !== '/api/session-records' || request.method !== 'GET') return false;
  if (!ownerReads) return ownerReadsUnavailable(response);
  sendJson(response, 200, await readSessionRecords(app, ownerReads, {
    personalSpaceId: url.searchParams.get('personalSpaceId'),
    sourceApplication: url.searchParams.get('sourceApplication'),
    sessionId: url.searchParams.get('sessionId') }));
  return true;
}
