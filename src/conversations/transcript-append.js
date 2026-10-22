import { ProviderRequestError } from '../graphiti/provider-client.js';
import { TRANSCRIPT_PAGES_PER_HOOK } from './transcript-guard.js';
import { readTranscriptBatch } from './transcript-reader.js';

export const CREDENTIAL_OMISSION = '[Visible transcript content omitted: it looked like a credential and was not saved; the original remains in native history.]';

const CREDENTIAL_FIELD = /^events\[(\d+)\]$/;
const CREDENTIAL_MESSAGE = /contains credentials/i;

// The Provider decides what looks like a credential and rejects the whole page
// when any event does. Without a way forward the transcript cursor could never
// pass that event, so task entry would stay blocked for the rest of the host
// session. Only the events the Provider names are replaced, once; every other
// rejection is reported unchanged.
export async function appendTranscriptPage(application, request) {
  try {
    return await application.personal.conversation('append', request);
  } catch (error) {
    const flagged = credentialEventIndexes(error, request.events.length);
    if (!flagged) throw error;
    const events = request.events.map((event, index) =>
      flagged.has(index) ? { ...event, content: CREDENTIAL_OMISSION } : event);
    return application.personal.conversation('append', { ...request, events });
  }
}

// Imports native bytes from request.expected_cursor up to `until`, a verified
// record end, a page at a time under request's task. Returns the cursor it
// reached: `until` once all of it was saved.
export async function importTranscriptSpan(application, request, input, adapter, until) {
  let cursor = request.expected_cursor;
  for (let page = 0; page < TRANSCRIPT_PAGES_PER_HOOK && cursor < until; page++) {
    const batch = await readTranscriptBatch(input.transcript_path, input.session_id, cursor, adapter, { stopAtCursor: until });
    if (batch.cursor === cursor) break;
    const saved = await appendTranscriptPage(application, { ...request, expected_cursor: cursor, cursor: batch.cursor,
      events: batch.events });
    if (saved.status !== 'saved') break;
    cursor = batch.cursor;
  }
  return cursor;
}

function credentialEventIndexes(error, count) {
  if (!(error instanceof ProviderRequestError) || error.status !== 422) return null;
  const failures = error.validationErrors?.length ? error.validationErrors : error.diagnostic?.validationErrors;
  if (!Array.isArray(failures) || !failures.length) return null;
  const indexes = new Set();
  for (const failure of failures) {
    const match = CREDENTIAL_FIELD.exec(failure?.field ?? '');
    if (!match || !CREDENTIAL_MESSAGE.test(failure?.message ?? '')) return null;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index >= count) return null;
    indexes.add(index);
  }
  return indexes;
}
