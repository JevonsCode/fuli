import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { jsonFormat, requireJsonFormatVersion, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { knowledgeReferences } from './forget-references.js';
import { hardDeleteLedgerSchema, HARD_DELETE_LEDGER_FINGERPRINT, ledgerDocument } from './ledger-format.js';

// The console's record of each permanent delete it starts (rec#5 C9), kept
// beside the local stores. It holds no words: an operation ID, the target,
// the preview digest the person confirmed, the IDs the preview said would go,
// the graph's deletion ID and the state:
//
//   pending        recorded before the graph delete was sent; the outcome is
//                  not known until the graph answers or is asked again
//   graph_deleted  the graph committed it; local cleanup has not finished
//   complete       the graph and every local store forgot it
//   not_deleted    proven: the graph refused it, or the item is still there
//                  long after any delete could have committed
//
// The same file is the fence every write into the local stores checks
// inside its own transaction (judgment.sqlite, role-work.sqlite): words that
// name a deleted item, or one being deleted, are never stored again, even by
// work that started before the delete. A refused delete leaves the fence.

export const HARD_DELETE_LEDGER_FORMAT = jsonFormat({ store: 'knowledge-hard-deletes', versions: [1, 2] });
export const HARD_DELETE_LEDGER_FILE = 'knowledge-hard-deletes.json';
const STATES = new Set(['pending', 'graph_deleted', 'complete', 'not_deleted']);
const OPEN_STATES = new Set(['pending', 'graph_deleted']);
const FENCED_STATES = new Set(['pending', 'graph_deleted', 'complete']);

export function hardDeleteLedger(dataDir, { now = () => new Date() } = {}) {
  const path = join(dataDir, HARD_DELETE_LEDGER_FILE);
  // The file is read and checked inside the format lock: a damaged one is
  // never rewritten from what could be read of it.
  const change = (mutate) => updateVersionedJsonFileAtomic(path, HARD_DELETE_LEDGER_FORMAT, (current) => {
    const operations = current === null ? [] : [...operationsOf(current)];
    mutate(operations);
    return ledgerDocument(operations, current?.watermarks ?? {});
  }, { read: (file) => parseLedger(file), durable: true });
  return {
    // Only a successful console/CLI reconcile may establish this proof. A v1
    // file upgrades losslessly here; its absence of proof never means synced.
    recordWatermark(spaceId, { count, latestDeletedAt }) {
      const watermark = { count, latestDeletedAt, reconciledAt: now().toISOString() };
      validateWatermark(watermark);
      if (!TEXT(spaceId)) throw new TypeError('Watermark needs a personal space');
      updateVersionedJsonFileAtomic(path, HARD_DELETE_LEDGER_FORMAT, current => ledgerDocument(
        current === null ? [] : operationsOf(current),
        { ...(current?.watermarks ?? {}), [spaceId]: watermark }
      ), { read: parseLedger, durable: true });
    },
    // A new pending operation, before anything irreversible is sent.
    begin({ spaceId, itemKind, itemId, previewId, itemIds }) {
      const at = now().toISOString();
      const operation = { id: randomUUID(), spaceId, itemKind, itemId, previewId, itemIds: [...new Set(itemIds)],
        state: 'pending', deletionId: null, deletedAt: null, createdAt: at, updatedAt: at };
      change((operations) => operations.push(operation));
      return operation;
    },
    update(id, patch) {
      let updated = null;
      change((operations) => {
        const index = operations.findIndex((operation) => operation.id === id);
        if (index < 0) throw new TypeError(`No permanent delete ${id} is recorded`);
        updated = { ...operations[index], ...patch, updatedAt: now().toISOString() };
        operations[index] = updated;
      });
      return updated;
    },
    // Operations whose outcome or cleanup is not finished.
    open: () => readLedger(path).filter((operation) => OPEN_STATES.has(operation.state)),
    all: () => readLedger(path),
    // The latest operation that targets or removed this item.
    find: (spaceId, itemId) => readLedger(path).filter((operation) => operation.spaceId === spaceId
      && (operation.itemId === itemId || operation.itemIds.includes(itemId))).at(-1) ?? null
  };
}

// The fence for a store file in a data directory, read again whenever the
// ledger beside it changes. A store in memory has none.
export function deletedKnowledgeBeside(storePath) {
  if (!storePath || storePath === ':memory:') return () => knowledgeReferences({});
  const path = join(dirname(storePath), HARD_DELETE_LEDGER_FILE);
  let seen = null;
  let operations = [];
  const references = new Map();
  return (spaceId = undefined) => {
    let stamp;
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      stamp = 'missing';
    }
    if (stamp !== seen) {
      operations = readLedger(path).filter((operation) => FENCED_STATES.has(operation.state));
      references.clear();
      seen = stamp;
    }
    if (!references.has(spaceId)) {
      // No scope preserves the aggregate reader contract. Body stores always
      // supply their row's space: opaque item IDs are not globally unique.
      const itemIds = operations.filter(operation => spaceId === undefined || operation.spaceId === spaceId)
        .flatMap(operation => [operation.itemId, ...operation.itemIds]);
      references.set(spaceId, knowledgeReferences({ itemIds,
        candidateKeys: itemIds.flatMap(id => ['entity', 'relationship', 'episode', 'session'].map(kind => `${kind}:${id}`)) }));
    }
    return references.get(spaceId);
  };
}

// Read-only, shared with the process-local gate. No migration or repair on read.
export function readHardDeleteProof(dataDir) {
  const document = parseLedger(join(dataDir, HARD_DELETE_LEDGER_FILE));
  if (document !== null) operationsOf(document);
  return document;
}

// Only a missing file is a first use. Any file that exists must be whole:
// a damaged one would read as "nothing deleted" and drop the fence, so it
// stops every write that depends on it until a person repairs it.
function readLedger(path) {
  const document = parseLedger(path);
  return document === null ? [] : operationsOf(document);
}

function parseLedger(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw damaged(`it cannot be read (${error?.code ?? error?.message})`);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw damaged('it is not valid JSON');
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw damaged('it is not a JSON object');
  }
  try {
    requireJsonFormatVersion(document, HARD_DELETE_LEDGER_FORMAT);
  } catch (error) {
    if (error instanceof DataFormatError) throw error;
    throw damaged('its format version is missing or unknown');
  }
  if (document.version === 2) {
    if (!hardDeleteLedgerSchema.safeParse(document).success || document.schemaFingerprint !== HARD_DELETE_LEDGER_FINGERPRINT) {
      throw damaged('its v2 schema or fingerprint does not match');
    }
    if (!document.watermarks || typeof document.watermarks !== 'object' || Array.isArray(document.watermarks)) {
      throw damaged('its watermarks are not an object');
    }
    for (const watermark of Object.values(document.watermarks)) validateWatermark(watermark);
  }
  return document;
}

function validateWatermark(value) {
  if (!value || !Number.isSafeInteger(value.count) || value.count < 0
      || (value.latestDeletedAt !== null && (typeof value.latestDeletedAt !== 'string' || !Number.isFinite(Date.parse(value.latestDeletedAt))))
      || (value.count === 0) !== (value.latestDeletedAt === null)
      || typeof value.reconciledAt !== 'string' || !Number.isFinite(Date.parse(value.reconciledAt))) {
    throw damaged('a synchronization watermark is invalid');
  }
}

const TEXT = (value) => typeof value === 'string' && value.length > 0;
const TEXT_OR_NULL = (value) => value === null || TEXT(value);

function operationsOf(document) {
  if (!Array.isArray(document.operations)) throw damaged('its operations are not a list');
  document.operations.forEach((operation, index) => {
    const problem = operationProblem(operation, document.version);
    if (problem) throw damaged(`operation ${index + 1} ${problem}`);
  });
  return document.operations;
}

function operationProblem(operation, version) {
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) return 'is not an object';
  for (const field of ['id', 'spaceId', 'itemId', 'createdAt', 'updatedAt']) {
    if (!TEXT(operation[field])) return `has no ${field}`;
  }
  const kinds = version === 1 ? ['entity', 'relationship'] : ['entity', 'relationship', 'episode', 'session'];
  if (!kinds.includes(operation.itemKind)) return 'has no item kind for this format version';
  if (!STATES.has(operation.state)) return `has the unknown state ${JSON.stringify(operation.state)}`;
  if (!Array.isArray(operation.itemIds) || !operation.itemIds.every(TEXT)) return 'has no list of item IDs';
  for (const field of ['previewId', 'deletionId', 'deletedAt']) {
    if (!TEXT_OR_NULL(operation[field] ?? null)) return `has an invalid ${field}`;
  }
  return null;
}

function damaged(reason) {
  return new DataFormatError(HARD_DELETE_LEDGER_FORMAT.store, 'data_format_damaged',
    `FULI's record of permanent deletes (${HARD_DELETE_LEDGER_FILE}) is damaged: ${reason}. Until it is repaired, `
    + 'FULI stores no knowledge words in its local judgment and work records and starts no permanent delete. '
    + 'Repair it by restoring it from a format backup, or by moving it out of the data directory and restarting '
    + 'FULI: the console then rebuilds it from the graph\'s deletion records and cleans the local stores again.');
}
