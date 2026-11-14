import { setTimeout as delay } from 'node:timers/promises';

import { resolveSetupPaths } from '../setup/paths.js';
import { runningConsoles } from '../system/fuli-process-scan.js';
import { singleLine } from '../text/single-line.js';
import { failure } from './release-asset.js';

// What an app update (the macOS app, a Windows installation) does once the new
// version's first start failed and the new version stopped: the previous
// version comes back only when it can run on the data; otherwise the new one
// stays selected and is started once more, so the installed program always
// matches the data. The failure names the first start error and what was done
// after it, on one line (the update journal keeps the first line only).

// The reason the previous version cannot run, from check(), or null. A check
// that fails counts as a reason: the previous version never comes back on
// data nobody could read.
export function previousVersionBlocked(check) {
  try { return check(); } catch (error) { return `its data could not be checked: ${reasonText(error?.message ?? error)}`; }
}

// With a reason, the new version stays: startAgain() → { ok, error }.
// Answers null (the previous version may come back), { ok: true } (the new
// version runs after all) or { ok: false, code: 'kept_new_version', outcome }.
export async function keepNewVersionOnNewerData(reason, startAgain) {
  if (!reason) return null;
  const retried = await startAgain();
  if (retried.ok) return { ok: true };
  return { ok: false, code: 'kept_new_version', outcome: `the previous version cannot run on this data (${reason}), `
    + `so the new one was kept; started again, it did not run (${reasonText(retried.error)}).` };
}

// The new version stays where it is when a start of FULI elsewhere did not
// finish in time, or when it did not stop: nothing may move under it.
export const startsStillRunning = error => ({ ok: false, code: 'kept_new_version',
  outcome: `another start of FULI did not finish, so it was left installed and nothing was switched back (${reasonText(error?.message ?? error)}).` });
export const newVersionDidNotStop = error => ({ ok: false, code: 'kept_new_version',
  outcome: `it did not stop either, so it was left installed and nothing was switched back (${reasonText(error)}).` });

// A console the failed start left is in no record a stop reads: one the start
// could not end, or one whose start was killed by a timeout. Nothing is read
// or moved while it may still upgrade the data or hold its port. Waits a
// bounded time for every console of this data directory to end; answers null,
// or why nothing may move (also when the processes could not be listed).
const LEFT_CONSOLE_WAIT_MS = 30_000;
const LEFT_CONSOLE_POLL_MS = 1000;

export async function consoleLeftRunning(dataDir, { scan = runningConsoles, wait = delay, now = Date.now } = {}) {
  const configPath = resolveSetupPaths({ dataDir }).graphRuntimeConfigPath;
  const deadline = now() + LEFT_CONSOLE_WAIT_MS;
  for (;;) {
    const running = await scan(configPath);
    if (running?.length === 0) return null;
    if (now() >= deadline) {
      return running ? `a FULI console still runs (process ${running.map(({ pid }) => pid).join(', ')})`
        : 'the running FULI processes could not be listed';
    }
    await wait(LEFT_CONSOLE_POLL_MS);
  }
}
export const consoleStillRunning = reason => ({ ok: false, code: 'kept_new_version',
  outcome: `${reason}, so it was left installed and nothing was switched back.` });

// Before an update stops FULI: a start that did not finish in time ends it.
export const startsBusyBeforeUpdate = error =>
  new Error(`Another start of FULI did not finish, so FULI was not stopped for the update; nothing was changed. ${reasonText(error?.message ?? error)}`);

// The update's failure: version, the first start error and { code, outcome }.
export function failedStartError(version, firstError, { code, outcome }) {
  return failure(`v${version} did not start (${reasonText(firstError)}); ${outcome}`, code);
}

export const reasonText = value => singleLine(value ?? 'no reason given') || 'no reason given';
