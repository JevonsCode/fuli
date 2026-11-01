import { dirname, join, resolve } from 'node:path';

import { jsonFormat, readJsonRecord, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// The console's first-run guide (Jevons 11-02): connect the AI clients on this
// computer, start at login, then where FULI records. It opens once, for an
// installation whose first setup opened the capture question
// (setup/first-run-capture.js); an installation from before has no record
// and is never shown it. Finishing or skipping it in the console closes it
// for good; 设置 › 客户端 opens it again without a record.
export const FIRST_RUN_GUIDE_FORMAT = jsonFormat({ store: 'first-run-guide', versions: [1] });
const OUTCOMES = Object.freeze(['finished', 'skipped']);

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
  return Object.freeze({
    // Called when a new installation opens its capture question; a guide
    // already opened or closed stays as it is.
    begin() {
      if (read() === null) write({ version: 1, status: 'open', since: now() });
    },
    state: () => ({ open: read()?.status === 'open' }),
    close(input) {
      const outcome = input?.outcome;
      if (!OUTCOMES.includes(outcome)) throw new TypeError(`First-run guide outcome must be one of ${OUTCOMES.join(', ')}`);
      const record = read();
      if (record?.status !== 'open') return { open: false };
      write({ version: 1, status: outcome, since: record.since, closedAt: now() });
      return { open: false };
    }
  });
}
