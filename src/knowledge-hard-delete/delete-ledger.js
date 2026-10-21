import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { jsonFormat, requireJsonFormatVersion, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { knowledgeReferences } from './forget-references.js';

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

export const HARD_DELETE_LEDGER_FORMAT = jsonFormat({ store: 'knowledge-hard-deletes', versions: [1] });
export const HARD_DELETE_LEDGER_FILE = 'knowledge-hard-deletes.json';
const OPEN_STATES = new Set(['pending', 'graph_deleted']);
const FENCED_STATES = new Set(['pending', 'graph_deleted', 'complete']);

export function hardDeleteLedger(dataDir, { now = () => new Date() } = {}) {
  const path = join(dataDir, HARD_DELETE_LEDGER_FILE);
  const change = (mutate) => updateVersionedJsonFileAtomic(path, HARD_DELETE_LEDGER_FORMAT, (current) => {
    const operations = [...(current?.operations ?? [])];
    mutate(operations);
    return { version: 1, operations };
  });
  return {
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
  let references = knowledgeReferences({});
  return () => {
    let stamp;
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      stamp = 'missing';
    }
    if (stamp !== seen) {
      const itemIds = readLedger(path).filter((operation) => FENCED_STATES.has(operation.state))
        .flatMap((operation) => [operation.itemId, ...operation.itemIds]);
      references = knowledgeReferences({ itemIds,
        candidateKeys: itemIds.flatMap((id) => [`entity:${id}`, `relationship:${id}`]) });
      seen = stamp;
    }
    return references;
  };
}

function readLedger(path) {
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  requireJsonFormatVersion(document, HARD_DELETE_LEDGER_FORMAT);
  return Array.isArray(document?.operations) ? document.operations : [];
}
