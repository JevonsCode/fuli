import { dirname, join, resolve } from 'node:path';

import { jsonFormat, readJsonRecord, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { positiveInteger } from '../validation/values.js';

// The console's first-run guide (Jevons 11-02): connect the AI clients on this
// computer, start at login, then where FULI records. It opens once, for an
// installation whose first setup opened the capture question
// (setup/first-run-capture.js); an installation from before has no record
// and is never shown it. Finishing or skipping it in the console closes it
// for good; 设置 › 客户端 opens it again without a record.
//
// The same record keeps the console's beginner's guide (新手引导, Jevons
// 11-12): tourSeen is the newest tour version the console has shown, so every
// installation, new or from before, sees each tour version once, in the
// browser and the desktop client alike. A record that only holds tourSeen has
// no status, so it never opens the first-run guide.
export const FIRST_RUN_GUIDE_FORMAT = jsonFormat({ store: 'first-run-guide', versions: [1] });
const OUTCOMES = Object.freeze(['finished', 'skipped']);
// Far above any tour the console will ship; it only bounds what a caller can store.
const MAX_TOUR_VERSION = 1000;

export function firstRunGuidePathForRuntime(runtimeConfigPath) {
  if (!runtimeConfigPath) return null;
  return join(dirname(resolve(runtimeConfigPath)), 'first-run-guide.json');
}

// path: the record's file, or null to keep it in memory. now(): ISO time.
export function createFirstRunGuide(path, { now = () => new Date().toISOString() } = {}) {
  let memory = null;
  const read = () => path ? readJsonRecord(path, FIRST_RUN_GUIDE_FORMAT) : memory;
  const write = record => {
    if (path) writeVersionedJsonFileAtomic(path, record, FIRST_RUN_GUIDE_FORMAT);
    else memory = record;
  };
  const state = () => {
    const record = read();
    return { open: record?.status === 'open', tourSeen: Number.isInteger(record?.tourSeen) ? record.tourSeen : null };
  };
  return Object.freeze({
    // Called when a new installation opens its capture question; a guide
    // already opened or closed stays as it is.
    begin() {
      if (read() === null) write({ version: 1, status: 'open', since: now() });
    },
    state,
    close(input) {
      const outcome = input?.outcome;
      if (!OUTCOMES.includes(outcome)) throw new TypeError(`First-run guide outcome must be one of ${OUTCOMES.join(', ')}`);
      const record = read();
      if (record?.status !== 'open') return state();
      write({ ...record, status: outcome, closedAt: now() });
      return state();
    },
    // The console showed this tour version; an older version never lowers it.
    markTourSeen(input) {
      const version = positiveInteger(input?.version, 'version', MAX_TOUR_VERSION);
      const record = read();
      if (Number.isInteger(record?.tourSeen) && record.tourSeen >= version) return state();
      write({ ...(record ?? { version: 1 }), tourSeen: version, tourSeenAt: now() });
      return state();
    }
  });
}
