import { dirname, join } from 'node:path';

import { acquireFileLock } from '../storage/file-lock.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// The one question a new installation asks (rec#5 C10): "FULI 要在哪些项目里
// 记录？" A record beside the capture settings says the question is open.
// Only a setup that creates FULI's data for the first time opens it
// (setup/first-run-capture.js), so an installation that existed before this
// version, or one FULI cannot show is new, has no record and is never asked:
// its settings stay as they are (all projects by default).
//
// While the question is open nothing is recorded: opening it turns automatic
// recording off, so the safe default is the global switch every write
// already obeys (capture-decision.js). Closing the question without an answer
// keeps it off and the console asks again the next time it opens. The answer
// comes from a FULI surface only, the console or an interactive terminal; no
// Agent tool (MCP or fuli_call) answers it, as with every long-term capture
// change (rec#11 D-16). Neither surface proves a person is present: local
// programs that can reach them are inside the console's trust boundary.
//
// Opening is a small state machine across two files, run one process at a
// time under its own lock: the record says "opening" first, then recording is
// switched off, then the record says "pending" with the settings version that
// switch produced. An interrupted opening resumes on the next setup or start,
// and an installation with an opening record is never taken for an existing
// one. Opening runs before the graph or any Agent starts and its failure stops
// setup, so nothing can record while the record says "opening".
//
// The open question is bound to that settings version, which no later save
// reuses (the settings store: monotonic generation with a nonce, moved by any
// change seen in the file, a restored or hand-edited file included). Any
// change since, by the person or anything else, closes it, and the answer is
// saved by compare-and-set against that same version, once.
export const CAPTURE_ONBOARDING_FORMAT = jsonFormat({ store: 'capture-onboarding', versions: [1] });
export const CAPTURE_SCOPE_CHOICES = Object.freeze(['all', 'selected', 'off']);
const SURFACES = Object.freeze(['console', 'terminal']);
const UNREADABLE = Object.freeze({ status: 'unreadable' });
const LOCK_FILE = 'capture-onboarding.lock';
const LOCK_WAIT_MS = 5000;

const writeOnboardingRecord = (path, record) => writeVersionedJsonFileAtomic(path, record, CAPTURE_ONBOARDING_FORMAT);

// store: the capture settings store. writeRecord(path, record) saves the
// question's record.
export function createCaptureOnboarding(store, { writeRecord = writeOnboardingRecord } = {}) {
  const path = store.path ? join(dirname(store.path), 'capture-onboarding.json') : null;
  let memory = null;
  const read = () => path ? readRecord(path) : memory;
  const write = record => {
    if (path) writeRecord(path, record);
    else memory = record;
  };
  const exclusively = operation => {
    if (!path) return operation();
    const release = acquireFileLock(join(dirname(path), LOCK_FILE), { waitMs: LOCK_WAIT_MS });
    try {
      return operation();
    } finally {
      release();
    }
  };
  const open = () => {
    const record = read();
    if (record?.status !== 'pending') return null;
    try {
      return store.version() === record.settingsVersion ? record : null;
    } catch {
      // Settings FULI cannot read are repaired in the settings, not here.
      return null;
    }
  };
  return Object.freeze({
    // Opens the question when isNew() says this installation is new, or
    // finishes an opening that was interrupted. isNew is asked again under
    // the lock, so two setups racing open it once.
    begin(isNew) {
      const record = read();
      if (record === null ? !isNew() : record.status !== 'opening') return;
      exclusively(() => {
        let current = read();
        if (current === null) {
          if (!isNew()) return;
          current = { version: 1, status: 'opening', since: store.now() };
          write(current);
        }
        if (current.status !== 'opening') return;
        const { version } = store.updateVersioned({ enabled: false });
        write({ version: 1, status: 'pending', since: current.since, settingsVersion: version });
      });
    },
    state: () => ({ ask: open() !== null }),
    answer(input, { surface }) {
      const { choice, change } = answerChange(input);
      if (!SURFACES.includes(surface)) throw new TypeError(`Capture scope surface must be one of ${SURFACES.join(', ')}`);
      return exclusively(() => {
        const record = open();
        if (!record) return { status: 'gone' };
        let saved;
        try {
          saved = store.update(change, { ifVersion: record.settingsVersion });
        } catch (error) {
          if (error?.code === 'capture_settings_changed') return { status: 'gone' };
          throw error;
        }
        // The settings have moved past the version the question is bound to,
        // so it is closed already; a record that cannot be written only loses
        // which surface answered.
        try {
          write({ version: 1, status: 'answered', since: record.since, choice, surface, answeredAt: saved.updatedAt });
        } catch {}
        return { status: 'answered', choice, capturePolicy: saved };
      });
    }
  });
}

// A missing record is null; one this FULI cannot read never asks.
function readRecord(path) {
  try {
    const record = readJsonFile(path, null);
    return record === null || record?.version === 1 ? record : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

// The settings each answer saves. Choosing projects records them only, and
// folders outside every project are left out (rec#5 C10-1, C2-3).
function answerChange(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Capture scope answer must be an object');
  const { choice, selectedProjectIds } = input;
  if (!CAPTURE_SCOPE_CHOICES.includes(choice)) {
    throw new TypeError(`Capture scope choice must be one of ${CAPTURE_SCOPE_CHOICES.join(', ')}`);
  }
  if (choice !== 'selected' && selectedProjectIds !== undefined) {
    throw new TypeError('Capture scope selectedProjectIds applies only to the selected choice');
  }
  if (choice === 'off') return { choice, change: { enabled: false } };
  if (choice === 'all') return { choice, change: { enabled: true, projectMode: 'all' } };
  return { choice, change: { enabled: true, projectMode: 'selected', selectedProjectIds: selectedProjectIds ?? [],
    unregisteredDirectories: 'skip' } };
}
