import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Bytes } from '../security/digest.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, readJsonRecord, removeVersionedJsonFileAtomic, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { DEBUG_RECORD_VERSION } from './record.js';

// The #debug turn records of one data directory (Jevons 11-04), one file per
// turn under debug-turns/, and the turn a #debug prompt began, kept until its
// Stop under debug-turns/pending/. Local only: nothing here reaches the Provider.
export const DEBUG_TURN_FORMAT = jsonFormat({ store: 'debug-turns', versions: [DEBUG_RECORD_VERSION] });
export const DEBUG_TURN_PENDING_FORMAT = jsonFormat({ store: 'debug-turn-pending', versions: [1] });
const PENDING_VERSION = 1;
const KEEP_RECORDS = 20;
const KEEP_BYTES = 50 * 1024 * 1024;
const RECORD_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

export function debugTurnStore(dataDir) {
  const directory = join(dataDir, 'debug-turns');
  const recordPath = (id) => join(directory, `${id}.json`);
  const pendingPath = (sourceApplication, sessionId) =>
    join(directory, 'pending', `${sha256Bytes(`${sourceApplication}\0${sessionId}`)}.json`);
  const read = (id) => {
    if (typeof id !== 'string' || !RECORD_FILE.test(`${id}.json`)) return null;
    const record = readJsonRecord(recordPath(id), DEBUG_TURN_FORMAT);
    return record?.version === DEBUG_RECORD_VERSION && record.id === id ? record : null;
  };
  // Every readable record with its file size, newest first. There are at most 20.
  const records = () => {
    let names;
    try { names = readdirSync(directory); } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return names.flatMap((name) => {
      const id = RECORD_FILE.exec(name)?.[1];
      const record = id ? read(id) : null;
      if (!record) return [];
      try { return [{ record, bytes: statSync(recordPath(id)).size }]; } catch { return []; }
    }).sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
  };

  return {
    list() {
      return records().map(({ record }) => ({ id: record.id, createdAt: record.createdAt,
        sourceApplication: record.sourceApplication, promptLine: record.promptLine, totals: record.totals }));
    },
    read,
    write(record) {
      writeVersionedJsonFileAtomic(recordPath(record.id), record, DEBUG_TURN_FORMAT);
      prune(records());
    },
    remove(id) {
      if (!read(id)) return false;
      removeVersionedJsonFileAtomic(recordPath(id), DEBUG_TURN_FORMAT);
      return true;
    },
    // The ones of these IDs that were there and are now gone.
    removeMany(ids) {
      return ids.filter((id) => this.remove(id));
    },
    // The turn a #debug prompt began in this session, until its Stop.
    pending: {
      read(sourceApplication, sessionId) {
        try {
          const value = readJsonFile(pendingPath(sourceApplication, sessionId), null);
          return value?.version === PENDING_VERSION && value.sessionId === sessionId ? value : null;
        } catch { return null; }
      },
      write(sourceApplication, sessionId, turn) {
        writeVersionedJsonFileAtomic(pendingPath(sourceApplication, sessionId),
          { version: PENDING_VERSION, sourceApplication, sessionId, ...turn }, DEBUG_TURN_PENDING_FORMAT);
      },
      remove(sourceApplication, sessionId) {
        removeVersionedJsonFileAtomic(pendingPath(sourceApplication, sessionId), DEBUG_TURN_PENDING_FORMAT);
      }
    }
  };

  // The newest 20 records within 50 MB; the newest one always stays.
  function prune(current) {
    let bytes = 0;
    current.forEach(({ record, bytes: size }, index) => {
      bytes += size;
      if (index > 0 && (index >= KEEP_RECORDS || bytes > KEEP_BYTES)) {
        removeVersionedJsonFileAtomic(recordPath(record.id), DEBUG_TURN_FORMAT);
      }
    });
  }
}
