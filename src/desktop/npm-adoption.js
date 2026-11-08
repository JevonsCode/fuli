import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataWaitsForPerson } from '../local-runtime/console-autostart.js';
import { isProcessAlive } from '../local-runtime/processes.js';
import { FULI_VERSION } from '../package-metadata.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { readJsonFile } from '../storage/json-file.js';
import { readJsonRecord, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { samePackageRoot } from './desktop-app-package.js';
import { DESKTOP_ADOPTION_FILE, DESKTOP_ADOPTION_FORMAT } from './npm-adoption-store.js';
import { clientDataUse } from './npm-copy-data.js';
import { findNpmCopies } from './npm-copies.js';

// How the desktop app becomes the one FULI of its data directory when the
// person installed FULI with npm first (both use the same data directory,
// src/setup/paths.js):
// - a console another package started (an npm copy, a checkout, an app
//   version from before consoles recorded their package) is restarted from
//   the app, so the app's code serves the shared data;
// - then every client FULI was connected to is pointed at the app's copy
//   (`setup --connected-only`, as an app update does), once per npm copy
//   whose clients use this data directory (npm-copy-data.js).
// It waits while a whole-store restore holds the data or a format step waits
// for the person (adoptionHold), and it leaves alone an npm copy that is newer
// than the app or serves other data, with the clients connected to it.
// The npm copy stays installed until the person removes it
// (npm-copy-control.js). Nothing in the data directory is moved or deleted.


// The console this data directory records, when a live process of another
// FULI package runs it: { pid, packageRoot } (packageRoot null when the
// console is from before consoles recorded it), else null.
export function otherPackageConsole(context, { readState = readRuntimeState, isAlive = isProcessAlive,
  platform = process.platform } = {}) {
  const state = readState(join(context.dataDir, 'graph-runtime-state.json'));
  if (!Number.isInteger(state?.pid) || !isAlive(state.pid)) return null;
  if (samePackageRoot(state.packageRoot, context.packageRoot, { platform })) return null;
  return { pid: state.pid, packageRoot: typeof state.packageRoot === 'string' ? state.packageRoot : null };
}

// Why the app does not take over this time, or null: { reason: 'data_busy' }
// (try again at the next start) or { reason: 'npm_newer', version } (the
// person updates the app first). other: otherPackageConsole's answer.
export function adoptionHold(context, other, { busy = dataWaitsForPerson, appVersion = FULI_VERSION,
  readVersion = packageVersion } = {}) {
  if (busy(context.dataDir)) return { reason: 'data_busy' };
  const version = other?.packageRoot ? readVersion(other.packageRoot) : null;
  return version && compareSemanticVersions(version, appVersion) > 0 ? { reason: 'npm_newer', version } : null;
}

// After the app's console runs: reconnects the clients when this start
// replaced another package's console, or found an npm copy not adopted
// before whose clients use this data directory. Nothing is reconnected while
// any npm copy is newer than the app or has clients on other data: one
// reconnection rewrites every connected client. invoke(args) runs the app's
// own CLI on this data directory. Answers null when there was nothing to do,
// else { clients: 'reconnected' | 'not_reconnected' | 'kept', npmCopies }. A
// reconnection that fails leaves the clients to the 体检's repair; it is not
// tried again at every start.
export async function reconnectAfterAdoption(context, { replaced, invoke, findCopies = findNpmCopies,
  dataUse = clientDataUse, appVersion = FULI_VERSION, now = () => new Date() }) {
  const copies = findCopies({ ownRoot: context.packageRoot, extraRoots: replaced?.packageRoot ? [replaced.packageRoot] : [] });
  if (!copies.length && !replaced) return null;
  const path = join(context.dataDir, DESKTOP_ADOPTION_FILE);
  const record = readJsonRecord(path, DESKTOP_ADOPTION_FORMAT);
  const known = new Set(Array.isArray(record?.npmCopies) ? record.npmCopies : []);
  const use = copies.length ? await dataUse(context, copies) : new Map();
  const seen = copies.map((copy) => ({ packageRoot: copy.packageRoot, version: copy.version,
    ...(use.get(copy.packageRoot) ?? { shares: null, dataDir: null }),
    newer: compareSemanticVersions(copy.version, appVersion) > 0 }));
  const kept = seen.filter((copy) => copy.shares === false || copy.newer);
  const fresh = seen.filter((copy) => copy.shares === true && !known.has(copy.packageRoot));
  const reconnect = !kept.length && (Boolean(replaced) || fresh.length > 0);
  const clients = reconnect ? ((await invoke(['setup', '--yes', '--connected-only'])).code === 0 ? 'reconnected' : 'not_reconnected')
    : 'kept';
  if (record?.status !== 'unreadable') {
    updateVersionedJsonFileAtomic(path, DESKTOP_ADOPTION_FORMAT, (current) => {
      const next = { ...emptyRecord(), ...current,
        copies: Object.fromEntries(seen.map(({ packageRoot, shares, dataDir }) => [packageRoot, { shares, dataDir }])) };
      return reconnect ? { ...next, adoptedAt: now().toISOString(), clients,
        npmCopies: [...known, ...fresh.map((copy) => copy.packageRoot)] } : next;
    });
  }
  return reconnect || kept.length ? { clients, npmCopies: copies.length } : null;
}

// What the person's console says about each copy: the other data its
// clients use, as the last start found it (reconnectAfterAdoption).
export function npmCopyDataSeen(dataDir) {
  const record = readJsonRecord(join(dataDir, DESKTOP_ADOPTION_FILE), DESKTOP_ADOPTION_FORMAT);
  return record?.copies && typeof record.copies === 'object' ? record.copies : {};
}

// The npm copies whose console notice the person closed; a closed notice
// stays closed, and Settings still lists the copy.
export function dismissedNpmNotices(dataDir) {
  const record = readJsonRecord(join(dataDir, DESKTOP_ADOPTION_FILE), DESKTOP_ADOPTION_FORMAT);
  return new Set(Array.isArray(record?.dismissed) ? record.dismissed : []);
}

export function setNpmNoticeDismissed(dataDir, packageRoot, dismissed) {
  updateVersionedJsonFileAtomic(join(dataDir, DESKTOP_ADOPTION_FILE), DESKTOP_ADOPTION_FORMAT, (current) => {
    const next = { ...emptyRecord(), ...current };
    const roots = new Set(next.dismissed);
    if (dismissed) roots.add(packageRoot); else roots.delete(packageRoot);
    return { ...next, dismissed: [...roots] };
  });
}

const emptyRecord = () => ({ version: 1, adoptedAt: null, npmCopies: [], clients: null, dismissed: [], copies: {} });

function packageVersion(packageRoot) {
  try { return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

function readRuntimeState(path) {
  try { return readJsonFile(path, null); } catch { return null; }
}
