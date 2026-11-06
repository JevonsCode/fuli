import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { acquireFileLock } from '../storage/file-lock.js';
import { DIAGNOSTIC_EVENT_VERSION, diagnosticEvent } from './safe-event.js';

// FULI's runtime failures in one data directory (rec#73): one JSON line per
// event under diagnostics/, appended by every FULI process (console, MCP,
// lifecycle hooks) at the seams that already catch a failure. Append-only:
// a line is never changed. Bounded: past 1 MB the file becomes events.jsonl.1,
// older copies move up and the oldest (.3) is dropped, so the log never holds
// more than 4 files of about 1 MB. Rotation runs under a cross-process lock;
// while it cannot run, a file at its hard cap takes no more events.
//
// Recording never fails or delays the operation it describes: record() is one
// synchronous append of under 1 KB, swallows every error, and creates nothing
// outside an existing data directory. A failure not caught at those seams (a
// hard power loss, a process killed before it wrote) leaves no event; see
// docs/diagnostics-log.md.

export const DIAGNOSTICS_DIRECTORY = 'diagnostics';
const EVENTS_FILE = 'events.jsonl';
const LOCK_FILE = '.events.lock';
const FILE_MAX_BYTES = 1024 * 1024;
const FILE_HARD_CAP_BYTES = FILE_MAX_BYTES + 256 * 1024;
const KEPT_COPIES = 3;
const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;

export function diagnosticEventLog(dataDir, { now = () => new Date(), lock = acquireFileLock } = {}) {
  const directory = join(dataDir, DIAGNOSTICS_DIRECTORY);
  const current = join(directory, EVENTS_FILE);
  // Oldest first, the current file last.
  const files = [...Array.from({ length: KEPT_COPIES }, (_, index) => `${current}.${KEPT_COPIES - index}`), current];

  return {
    // Returns whether the event was written; false is never an error to report.
    record(fields) {
      try {
        const line = `${JSON.stringify(diagnosticEvent(fields, { now: now() }))}\n`;
        if (!openDirectory()) return false;
        if (sizeOf(current) + Buffer.byteLength(line) > FILE_HARD_CAP_BYTES) return false;
        appendFileSync(current, line, { encoding: 'utf8', mode: PRIVATE_FILE });
        if (sizeOf(current) > FILE_MAX_BYTES) rotate();
        return true;
      } catch {
        return false;
      }
    },

    // Every stored event, oldest file first; what could not be read is named, never skipped silently.
    read() {
      const events = [];
      const sourcesUnavailable = [];
      let skippedLines = 0;
      let present = 0;
      for (const path of files) {
        let text;
        try { text = readFileSync(path, 'utf8'); } catch (error) {
          if (error?.code !== 'ENOENT') sourcesUnavailable.push({ source: label(path), reason: error?.code ?? 'unreadable' });
          continue;
        }
        present += 1;
        for (const line of text.split('\n')) {
          if (!line) continue;
          const event = parseLine(line);
          if (event) events.push(event);
          else skippedLines += 1;
        }
      }
      // Once the oldest kept copy exists, each rotation drops events before it.
      return { events, sourcesUnavailable, skippedLines, stored: present > 0,
        mayHaveDropped: Boolean(statSync(files[0], { throwIfNoEntry: false })) };
    }
  };

  function openDirectory() {
    try {
      mkdirSync(directory, { mode: PRIVATE_DIRECTORY });
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
    }
    return true;
  }

  function rotate() {
    let release;
    try { release = lock(join(directory, LOCK_FILE)); } catch { return; }
    try {
      if (sizeOf(current) <= FILE_MAX_BYTES) return;
      rmSync(files[0], { force: true });
      for (let index = 1; index < files.length; index += 1) {
        if (statSync(files[index], { throwIfNoEntry: false })) renameSync(files[index], files[index - 1]);
      }
    } catch {
      // A copy another process holds open stays; the next append past the limit tries again.
    } finally {
      release();
    }
  }

  function label(path) {
    return `${DIAGNOSTICS_DIRECTORY}/${path.slice(directory.length + 1)}`;
  }
}

// The log as `fuli migrate status` reports it, read only. Lines carry their
// own version; a line this FULI does not read is skipped and counted by read().
export function inspectDiagnosticEvents(dataDir) {
  const report = { store: 'diagnostic-events', kind: 'jsonl', target: DIAGNOSTIC_EVENT_VERSION, version: null,
    ledger: [], steps: [] };
  try {
    statSync(join(dataDir, DIAGNOSTICS_DIRECTORY, EVENTS_FILE));
    return { ...report, version: DIAGNOSTIC_EVENT_VERSION, state: 'current' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...report, state: 'absent' };
    return { ...report, state: 'unavailable', note: `cannot be read (${error?.code ?? 'unreadable'})` };
  }
}

function parseLine(line) {
  try {
    const event = JSON.parse(line);
    return event?.v === DIAGNOSTIC_EVENT_VERSION && typeof event.id === 'string' && typeof event.at === 'string'
      && Number.isFinite(Date.parse(event.at)) ? event : null;
  } catch {
    return null;
  }
}

function sizeOf(path) {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}
