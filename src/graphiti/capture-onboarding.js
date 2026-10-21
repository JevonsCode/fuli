import { dirname, join } from 'node:path';

import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// The one question a new installation asks (rec#5 C10): "FULI 要在哪些项目里
// 记录？" A record beside the capture settings says the question is open.
// Only a setup that created FULI's data for the first time opens it
// (setup/first-run-capture.js), so an installation that existed before this
// version, or one FULI cannot show is new, has no record and is never asked:
// its settings stay as they are (all projects by default).
//
// While the question is open nothing is recorded: opening it turns automatic
// recording off, so the safe default is the global switch every write
// already obeys (capture-decision.js). Closing the question without an answer
// keeps it off and the console asks again the next time it opens. The person
// answers on a FULI surface only, the console or their own terminal; no Agent
// tool reaches it, as with every long-term capture change (rec#11 D-16). The
// answer is saved into the capture settings by compare-and-set, once. A change
// the person makes in the settings meanwhile answers it too: the question
// stays open only while the settings are still those it was opened with.
export const CAPTURE_ONBOARDING_FORMAT = jsonFormat({ store: 'capture-onboarding', versions: [1] });
export const CAPTURE_SCOPE_CHOICES = Object.freeze(['all', 'selected', 'off']);
const SURFACES = Object.freeze(['console', 'terminal']);
const UNREADABLE = Object.freeze({ status: 'unreadable' });

// store: the capture settings store.
export function createCaptureOnboarding(store) {
  const path = store.path ? join(dirname(store.path), 'capture-onboarding.json') : null;
  let memory = null;
  const read = () => path ? readRecord(path) : memory;
  const write = record => {
    if (path) writeVersionedJsonFileAtomic(path, record, CAPTURE_ONBOARDING_FORMAT);
    else memory = record;
  };
  const open = () => {
    const record = read();
    if (record?.status !== 'pending') return null;
    try {
      return store.read().updatedAt === record.settingsUpdatedAt ? record : null;
    } catch {
      // Settings FULI cannot read are repaired in the settings, not here.
      return null;
    }
  };
  return Object.freeze({
    // Opens the question for an installation setup has just found to be new.
    // An installation that already has a record keeps it, so a setup run
    // again after an interrupted first one asks the same open question.
    begin() {
      if (read() !== null) return;
      const saved = store.update({ enabled: false });
      write({ version: 1, status: 'pending', since: saved.updatedAt, settingsUpdatedAt: saved.updatedAt });
    },
    state: () => ({ ask: open() !== null }),
    answer(input, { surface }) {
      const { choice, change } = answerChange(input);
      if (!SURFACES.includes(surface)) throw new TypeError(`Capture scope surface must be one of ${SURFACES.join(', ')}`);
      const version = store.version();
      const record = open();
      if (!record) return { status: 'gone' };
      let saved;
      try {
        saved = store.update(change, { ifVersion: version });
      } catch (error) {
        if (error?.code === 'capture_settings_changed') return { status: 'gone' };
        throw error;
      }
      // Saved settings already close the question (they changed), so a record
      // that cannot be written only loses which surface answered.
      try {
        write({ version: 1, status: 'answered', since: record.since, choice, surface, answeredAt: saved.updatedAt });
      } catch {}
      return { status: 'answered', choice, capturePolicy: saved };
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
