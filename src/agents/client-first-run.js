import { approveFuliInFolder, CURSOR_APPROVE_COMMAND, cursorFirstRunPending } from './cursor/first-run.js';

// What a client still asks the person the first time FULI's entry is used in
// it, and the one step FULI can take for them, by client id. Each client's own
// module owns its behaviour (AGENTS.md: client differences live under
// src/agents/<client>/); the common layer only looks one up. The console's
// messages hold the words; this holds the command shown before it runs.
//   pending({ commandFound, homeDir }) → whether the card should say it now
//   run(folder, { locate }) → { status, command, folder, output? }
const FIRST_RUN = Object.freeze({
  cursor: { command: CURSOR_APPROVE_COMMAND, pending: cursorFirstRunPending, run: approveFuliInFolder }
});

export const clientFirstRun = (id) => (Object.hasOwn(FIRST_RUN, id) ? FIRST_RUN[id] : null);
