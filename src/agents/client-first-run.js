import { cursorFirstRun } from './cursor/first-run.js';

// What a client still asks the person the first time FULI's entry is used in
// it, by client id. Each client's own module owns its sentence (AGENTS.md:
// client differences live under src/agents/<client>/); the common layer only
// looks one up, so a client without such a step needs nothing here.
const FIRST_RUN = Object.freeze({ cursor: cursorFirstRun });

// The step for this client, or null. The console sends the id instead of the
// sentence, so its own wording stays in the two console languages.
export const clientFirstRunStep = (id) => (Object.hasOwn(FIRST_RUN, id) ? FIRST_RUN[id]() : null);
export const hasClientFirstRun = (id) => Object.hasOwn(FIRST_RUN, id);
