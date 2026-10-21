import { join } from 'node:path';

import { jsonFormat, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { readJsonFile } from '../storage/json-file.js';

// What a person did to the data formats of one data directory (rec#17 D-09
// part 2): applied, undone and restored migrations and pruned backups. Store,
// step IDs, versions, counts and backup names only, never record content.
// The receipt and the console read recent entries from here.

const LOG_VERSION = 1;
const KEPT_EVENTS = 200;
export const FORMAT_OPERATIONS_FORMAT = jsonFormat({ store: 'format-operations', versions: [LOG_VERSION] });

function formatOperationsPath(dataDir) {
  return join(dataDir, 'format-operations.json');
}

export function recordFormatOperations(dataDir, events) {
  if (!events.length) return;
  updateVersionedJsonFileAtomic(formatOperationsPath(dataDir), FORMAT_OPERATIONS_FORMAT, (current) => ({
    version: LOG_VERSION, events: [...(current?.events ?? []), ...events].slice(-KEPT_EVENTS)
  }));
}

export function readFormatOperations(dataDir) {
  try {
    return readJsonFile(formatOperationsPath(dataDir), { events: [] }).events ?? [];
  } catch {
    return [];
  }
}
