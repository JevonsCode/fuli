import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { acquireFileLock } from '../storage/file-lock.js';
import { jsonFormat, readJsonRecord, updateVersionedJsonFileAtomic } from '../storage/json-format.js';

// What the automatic console start (console-autostart.js) remembers in one
// data directory, shared by every client session's MCP process (rec#94):
// whether the person stopped FULI on purpose, when it was started
// automatically, and why it is no longer started automatically. A person's
// start clears all of it; a person's stop records stoppedAt before the
// console stops, so no session brings it back meanwhile. A restart is not a
// stop: it holds the start lock instead (lifecycle.js).

export const CONSOLE_AUTOSTART_FILE = 'console-autostart.json';
export const CONSOLE_AUTOSTART_FORMAT = jsonFormat({ store: 'console-autostart', versions: [1] });
const EMPTY = Object.freeze({ version: 1, stoppedAt: null, starts: [], held: null });
// held.reason: gave_up (too many starts in the window) or data_format
// (a data format step waits for the person).
const HELD_REASONS = new Set(['gave_up', 'data_format']);

const recordPath = dataDir => join(dataDir, CONSOLE_AUTOSTART_FILE);
const START_LOCK_FILE = '.console-start.lock';

// The one lock of every console start in a data directory: each `fuli
// start` (the person's, the desktop client's, an automatic one) holds it
// while it starts, and a session holds it while it decides, so two starts
// never run at once. waitMs 0 fails at once with code file_lock_busy.
export function acquireConsoleStartLock(dataDir, { waitMs = 0 } = {}) {
  return acquireFileLock(join(dataDir, START_LOCK_FILE), { waitMs });
}

// How long a start waits for another one to finish (Neo4j's first start is slow).
export const CONSOLE_START_WAIT_MS = 5 * 60_000;

// The start lock once a start under way has finished, so a stop that follows
// sees the console it recorded and no start begins until release. An app
// update holds it around its stop and switch.
export function waitForConsoleStarts(dataDir) {
  return acquireConsoleStartLock(dataDir, { waitMs: CONSOLE_START_WAIT_MS });
}

// The record, or { unreadable: true } for one this FULI does not read.
export function readConsoleAutostart(dataDir) {
  const record = readJsonRecord(recordPath(dataDir), CONSOLE_AUTOSTART_FORMAT);
  if (record?.status === 'unreadable') return { unreadable: true };
  return normalize(record);
}

// mutate(record) returns the next record, or undefined to keep it; returns
// the record as it is afterwards.
export function updateConsoleAutostart(dataDir, mutate) {
  return normalize(updateVersionedJsonFileAtomic(recordPath(dataDir), CONSOLE_AUTOSTART_FORMAT,
    current => {
      const next = mutate(normalize(current));
      return next === undefined ? undefined : { ...next, version: 1 };
    }));
}

export function recordPersonStop(dataDir, now = new Date()) {
  updateConsoleAutostart(dataDir, () => ({ ...EMPTY, stoppedAt: now.toISOString() }));
}

// A start the person asked for wants FULI again: nothing is held any more.
// Writes only over an existing record, so a first start creates no file.
export function recordPersonStart(dataDir) {
  if (!existsSync(recordPath(dataDir))) return;
  updateConsoleAutostart(dataDir, current => sameAs(current, EMPTY) ? undefined : { ...EMPTY });
}

function normalize(record) {
  if (!record || typeof record !== 'object') return { ...EMPTY };
  return {
    version: 1,
    stoppedAt: typeof record.stoppedAt === 'string' ? record.stoppedAt : null,
    starts: Array.isArray(record.starts) ? record.starts.filter(at => Number.isFinite(Date.parse(at))) : [],
    held: HELD_REASONS.has(record.held?.reason) && typeof record.held.at === 'string'
      ? { reason: record.held.reason, at: record.held.at } : null
  };
}

function sameAs(a, b) {
  return a.stoppedAt === b.stoppedAt && a.held === b.held && a.starts.length === b.starts.length;
}
