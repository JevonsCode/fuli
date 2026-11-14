import { dirname, join, resolve } from 'node:path';

import { InvalidInputError } from '../app/application-error.js';
import { dreamingConnected, DREAMING_OPERATION } from '../dreaming/astro-calls.js';
import { jsonFormat, readJsonRecord, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// The console's advanced areas stay out of sight until this installation has
// a trace of them (Jevons 11-15): their data exists, their switch is on, or
// the person or a link opened them. Once shown, an area never hides again;
// nothing here removes an id. Every API keeps working whether an area is
// shown or not: this record only decides what the console offers.
//
// observe() runs on every state read (the console's start path), so each
// check is a cheap local read: a file's existence, a JSON file, a single-row
// SQLite query. A check that fails or throws adds nothing and is tried again
// on the next read. An unreadable record shows every area.
export const ADVANCED_AREAS_FORMAT = jsonFormat({ store: 'advanced-areas', versions: [1] });
const ADVANCED_AREAS = Object.freeze(['roundtable', 'tonborg', 'tidy', 'lan']);
// Why an area is shown: the observation found a trace, the person pressed
// Show, or a link (a bookmark, a receipt, an Agent's answer) led there.
const REVEAL_REASONS = Object.freeze(['person', 'link']);

const spaceOf = app => app.config.personal.spaceId;
const TRACES = Object.freeze({
  // A roundtable thread, a local Agent chat or a group discussion.
  roundtable: app => app.roundtable?.used() === true,
  // 交给 Tonborg 确认 switched at any time, anything Tonborg confirmed for the person, or a judgment policy set.
  tonborg: app => app.judgment?.store().automaticConfirmationUsed(spaceOf(app)) === true,
  // A project 整理 run, a Dreaming run, or Dreaming switched on.
  tidy: app => app.projectOrganizing?.started() === true
    || app.roleSuggestions?.hasOperation(DREAMING_OPERATION) === true
    || dreamingConnected(app),
  // The LAN data (a role, a pairing, a nearby attempt, a share), a guest link, a visitor read or a visit request.
  lan: app => app.peer?.configured() === true || app.visitorAccess?.used() === true
});

export function advancedAreasPathForRuntime(runtimeConfigPath) {
  if (!runtimeConfigPath) return null;
  return join(dirname(resolve(runtimeConfigPath)), 'advanced-areas.json');
}

// path: the record's file, or null to keep it in memory. now(): ISO time.
export function createAdvancedAreas(path, { now = () => new Date().toISOString() } = {}) {
  let memory = null;
  const read = () => path ? readJsonRecord(path, ADVANCED_AREAS_FORMAT) : memory;
  const write = record => {
    if (path) writeVersionedJsonFileAtomic(path, record, ADVANCED_AREAS_FORMAT);
    else memory = record;
  };
  const readable = record => record?.status !== 'unreadable';
  const view = shown => ({ shown: ADVANCED_AREAS.filter(id => Object.hasOwn(shown, id)) });

  // Adds the ids to the record; one already there keeps its first time and reason.
  function add(record, entries) {
    const shown = { ...(record?.shown ?? {}) };
    for (const [id, why] of entries) if (!Object.hasOwn(shown, id)) shown[id] = { at: now(), why };
    // A failed write still shows what was found now; the next read finds it again.
    try { write({ version: 1, shown }); } catch { /* fail open */ }
    return view(shown);
  }

  return Object.freeze({
    // The areas that now have a trace join the shown ones; returns { shown: [...ids] }.
    observe(app) {
      const record = read();
      if (!readable(record)) return { shown: [...ADVANCED_AREAS] };
      const shown = record?.shown ?? {};
      const found = ADVANCED_AREAS.filter(id => !Object.hasOwn(shown, id) && traced(app, id));
      return found.length ? add(record, found.map(id => [id, 'observed'])) : view(shown);
    },
    reveal(input) {
      const id = input?.id;
      const why = input?.why ?? 'person';
      if (!ADVANCED_AREAS.includes(id)) throw new InvalidInputError(`id must be one of ${ADVANCED_AREAS.join(', ')}`);
      if (!REVEAL_REASONS.includes(why)) throw new InvalidInputError(`why must be one of ${REVEAL_REASONS.join(', ')}`);
      const record = read();
      if (!readable(record)) return { shown: [...ADVANCED_AREAS] };
      return add(record, [[id, why]]);
    }
  });
}

function traced(app, id) {
  try { return TRACES[id](app); } catch { return false; }
}
