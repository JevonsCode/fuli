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

// Before an update stops FULI: a start that did not finish in time ends it.
export const startsBusyBeforeUpdate = error =>
  new Error(`Another start of FULI did not finish, so FULI was not stopped for the update; nothing was changed. ${reasonText(error?.message ?? error)}`);

// The update's failure: version, the first start error and { code, outcome }.
export function failedStartError(version, firstError, { code, outcome }) {
  return failure(`v${version} did not start (${reasonText(firstError)}); ${outcome}`, code);
}

export const reasonText = value => singleLine(value ?? 'no reason given') || 'no reason given';
