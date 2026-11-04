import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { sha256Bytes } from '../security/digest.js';
import { jsonFormat, readJsonRecord, updateVersionedJsonFileAtomic } from '../storage/json-format.js';

// rec#82: a person's confirmed session migration, kept for the host session
// that holds the items until that session's next task entry claims it. One
// file per client and host session, named by their hash, so an entry reads
// and claims only its own session's events and a session with none reads
// nothing. An event holds counts and ids only, never knowledge text, and
// grants nothing. The first task entry to claim an event keeps it; a retry
// of that same task sees it again, any other task never does.

export const SESSION_MIGRATION_NOTICE_FORMAT = jsonFormat({ store: 'session-migration-notice', versions: [1] });
export const SESSION_MIGRATION_NOTICE_DIRECTORY = 'session-migration-notices';
const FORMAT_VERSION = 1;
// A session confirms few migrations; the oldest beyond this are dropped.
const MAX_EVENTS = 20;

export function sessionMigrationNoticesForRuntime(runtimeConfigPath) {
  return createSessionMigrationNotices(runtimeConfigPath
    ? join(dirname(resolve(runtimeConfigPath)), SESSION_MIGRATION_NOTICE_DIRECTORY) : null);
}

// directory: where the session files live, or null when this application has
// no data directory; then nothing is recorded and nothing can be delivered.
function createSessionMigrationNotices(directory, { now = () => new Date().toISOString() } = {}) {
  const path = ({ sourceApplication, sessionId }) => join(directory,
    `${contentHash({ purpose: 'session-migration-notice-v1', sourceApplication, sessionId })}.json`);
  const events = session => readJsonRecord(path(session), SESSION_MIGRATION_NOTICE_FORMAT)?.events ?? [];
  return Object.freeze({
    available: Boolean(directory),
    // The completed migration, once per migration id: a repeated record returns the first one unchanged.
    record(session, { migrationId, targetProjectId, moved, heldCount }) {
      if (!directory) return null;
      let stored = null;
      updateVersionedJsonFileAtomic(path(session), SESSION_MIGRATION_NOTICE_FORMAT, current => {
        const kept = current?.events ?? [];
        stored = kept.find(event => event.migrationId === migrationId) ?? null;
        if (stored) return undefined;
        stored = { migrationId, targetProjectId, moved, heldCount, appliedAt: now(), delivery: null };
        return { version: FORMAT_VERSION, events: [...kept, stored].slice(-MAX_EVENTS) };
      });
      return stored;
    },
    find(session, migrationId) {
      if (!directory) return null;
      return events(session).find(event => event.migrationId === migrationId) ?? null;
    },
    // The events this task entry delivers: those nobody claimed yet, and those this same task claimed before.
    claim(session, taskToken) {
      if (!directory || !existsSync(path(session))) return [];
      const task = sha256Bytes(taskToken);
      const result = updateVersionedJsonFileAtomic(path(session), SESSION_MIGRATION_NOTICE_FORMAT, current => {
        if (!current?.events.some(event => !event.delivery)) return undefined;
        const at = now();
        return { ...current, events: current.events.map(event => event.delivery ? event
          : { ...event, delivery: { task, at } }) };
      });
      return (result?.events ?? []).filter(event => event.delivery?.task === task);
    }
  });
}
