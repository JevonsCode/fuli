import { join } from 'node:path';

import { isProcessAlive } from '../local-runtime/processes.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, readJsonRecord, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { samePackageRoot } from './desktop-app-package.js';
import { findNpmCopies } from './npm-copies.js';

// How the desktop app becomes the one FULI of its data directory when the
// person installed FULI with npm first (both use the same data directory,
// src/setup/paths.js):
// - a console another package started (an npm copy, a checkout, an app
//   version from before consoles recorded their package) is restarted from
//   the app, so the app's code serves the shared data;
// - then, once per npm copy found, every client FULI was connected to is
//   pointed at the app's copy (`setup --connected-only`, as an app update
//   does), so client sessions run the app's MCP server and hooks.
// The npm copy itself stays installed: removing it changes the person's
// environment, so the console's 体检 says how (doctor.js npm_copy_installed).
// Nothing in the data directory is moved or deleted.

export const DESKTOP_ADOPTION_FILE = 'desktop-app-adoption.json';
export const DESKTOP_ADOPTION_FORMAT = jsonFormat({ store: 'desktop-app-adoption', versions: [1] });

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

// After the app's console runs: reconnects the clients when this start
// replaced another package's console or found an npm copy it has not
// adopted before. invoke(args) runs the app's own CLI on this data
// directory. Answers null when there was nothing to do, else
// { clients: 'reconnected' | 'not_reconnected', npmCopies }. A reconnection
// that fails leaves the clients to the 体检's repair; it is not tried again
// at every start.
export async function reconnectAfterAdoption(context, { replaced, invoke, findCopies = findNpmCopies,
  now = () => new Date() }) {
  const copies = findCopies({ ownRoot: context.packageRoot, extraRoots: replaced?.packageRoot ? [replaced.packageRoot] : [] });
  const path = join(context.dataDir, DESKTOP_ADOPTION_FILE);
  const record = readJsonRecord(path, DESKTOP_ADOPTION_FORMAT);
  const known = new Set(Array.isArray(record?.npmCopies) ? record.npmCopies : []);
  const fresh = copies.filter((copy) => !known.has(copy.packageRoot));
  if (!replaced && !fresh.length) return null;
  const result = await invoke(['setup', '--yes', '--connected-only']);
  const clients = result.code === 0 ? 'reconnected' : 'not_reconnected';
  if (record?.status !== 'unreadable') {
    updateVersionedJsonFileAtomic(path, DESKTOP_ADOPTION_FORMAT, (current) => ({ ...emptyRecord(), ...current,
      adoptedAt: now().toISOString(), npmCopies: [...known, ...fresh.map((copy) => copy.packageRoot)], clients }));
  }
  return { clients, npmCopies: copies.length };
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

const emptyRecord = () => ({ version: 1, adoptedAt: null, npmCopies: [], clients: null, dismissed: [] });

function readRuntimeState(path) {
  try { return readJsonFile(path, null); } catch { return null; }
}
