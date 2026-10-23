import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';
import { ProviderRequestError } from '../graphiti/provider-client.js';
import { JudgmentStore } from '../judgment/store.js';
import { RoleWorkStore } from '../model-backends/role-work-store.js';
import { RoleSuggestionLog } from '../model-backends/suggestion-log.js';
import { hardDeleteLedger } from './delete-ledger.js';
import { knowledgeReferences } from './forget-references.js';

// A person's hard delete of one knowledge item from the local console
// (rec#5 C9). The provider plans, checks the preview and deletes in one
// transaction; its routes take the human-review token this port sends
// (human-review-channel.js), so no Agent or MCP tool path can preview or
// delete. Each delete is recorded before it is sent (delete-ledger.js), so an
// answer lost to a timeout or a crash is settled by asking the graph, never by
// sending the delete again. Once the graph committed, the local stores that
// keep words about knowledge forget the removed items: Tonborg's judgments and
// receipts (judgment.sqlite), handed-off work packages (role-work.sqlite) and
// the built-in Agents' suggestion records (role-suggestions.sqlite).
// Only the console's loopback routes use this module; no MCP or Agent tool
// module imports it (test/knowledge-hard-delete-console.test.js).

const DELETE_TIMEOUT_MS = 5 * 60_000;
// After this long without an answer, a pending operation is ended through
// the graph's abort, which waits for a delete that still runs and wins only
// when none committed. Time alone never decides the outcome.
const ABORT_AFTER_MS = 2 * DELETE_TIMEOUT_MS;

// The other local stores keep no item words or IDs, so a hard delete leaves
// them as they are: preference-delivery (scope, snapshot and frame hashes),
// transcript-capture (capture settings versions per session), the capture
// settings, previews and onboarding files, model-usage.sqlite (counts), and the
// task schedule, Agent app, employee, roundtable and peer stores (no
// knowledge items; an Agent's own roundtable messages are its records).

export function knowledgeHardDelete(dataDir, {
  send = personalHumanReviewChannel(dataDir),
  localStores = defaultLocalStores(dataDir),
  now = () => new Date(),
  ledger = hardDeleteLedger(dataDir, { now }),
  // The active personal space, for rebuilding the record from the graph.
  personalSpaceId = () => null,
  deleteTimeoutMs = DELETE_TIMEOUT_MS,
  abortAfterMs = ABORT_AFTER_MS
} = {}) {
  const item = (path, input) => `/v1/knowledge/items/${encodeURIComponent(input.itemId)}${path}`;
  const operationPath = (operation, path = '') => `/v1/knowledge/hard-delete-operations/${operation.id}${path}`;
  const ref = (input) => ({ personal_space_id: input.personalSpaceId, item_kind: input.itemKind });
  const request = async (path, body, timeoutMs) => {
    const { ok, status, payload } = await send(path, body, { review: true, timeoutMs });
    if (ok) return payload;
    throw providerRefusal(status, payload);
  };
  const graphDeleted = (operation, deletion) => ledger.update(operation.id, { state: 'graph_deleted',
    deletionId: deletion.deletion_id, deletedAt: deletion.deleted_at,
    itemIds: [...new Set([...operation.itemIds, ...deletion.deleted_item_ids])] });
  // Local cleanup from the recorded operation: idempotent, so a retry or the
  // next console start runs it again until every store forgot.
  const cleanUp = (operation, deletion) => {
    const stores = forgetLocally(localStores, operation.spaceId, operation.itemIds);
    const complete = stores.every((store) => store.status === 'forgotten');
    if (complete) ledger.update(operation.id, { state: 'complete' });
    return { outcome: complete ? 'complete' : 'local_pending', ...deletion, local_stores: stores };
  };
  const unknown = (operation) => ({ outcome: 'unknown', item_kind: operation.itemKind, item_id: operation.itemId });
  const notDeleted = (operation, code) => {
    ledger.update(operation.id, { state: 'not_deleted' });
    return { outcome: 'not_deleted', code, item_kind: operation.itemKind, item_id: operation.itemId };
  };
  // A terminal answer of the graph about this operation.
  const conclude = async (operation, answer) => {
    if (answer.state === 'committed') return cleanUp(graphDeleted(operation, answer.deletion), answer.deletion);
    if (answer.state === 'refused' && answer.code === 'hard_deleted') {
      // Another delete removed the item first: clean up after that one.
      const status = await request(item('/hard-delete/status', { itemId: operation.itemId }),
        { personal_space_id: operation.spaceId, item_kind: operation.itemKind });
      if (status.state === 'deleted') return cleanUp(graphDeleted(operation, status.deletion), status.deletion);
    }
    return notDeleted(operation, answer.code);
  };
  // A pending operation's outcome, only ever from the graph's durable record
  // of it: never by sending the irreversible delete again, never by time.
  const settle = async (operation) => {
    const space = { personal_space_id: operation.spaceId };
    try {
      let answer = await request(operationPath(operation), space);
      if (answer.state === 'unknown' && now() - Date.parse(operation.createdAt) > abortAfterMs) {
        answer = await request(operationPath(operation, '/abort'), space, deleteTimeoutMs);
      }
      return answer.state === 'unknown' ? unknown(operation) : await conclude(operation, answer);
    } catch {
      return unknown(operation);
    }
  };
  const resume = (operation) => operation.state === 'pending' ? settle(operation)
    : cleanUp(operation, { deletion_id: operation.deletionId, item_kind: operation.itemKind, item_id: operation.itemId,
      deleted_at: operation.deletedAt, deleted_item_ids: operation.itemIds });
  // Every deletion the graph recorded that this record does not know (a
  // record moved aside or restored from an older backup) is taken in again
  // and cleaned up locally.
  const adoptGraphDeletions = async () => {
    const spaceId = personalSpaceId();
    if (!spaceId) return [];
    const known = new Set(ledger.all().map((operation) => operation.deletionId).filter(Boolean));
    const adopted = [];
    for (const deletion of await request('/v1/knowledge/hard-deletions', { personal_space_id: spaceId })) {
      if (known.has(deletion.deletion_id)) continue;
      const operation = ledger.begin({ spaceId, itemKind: deletion.item_kind, itemId: deletion.item_id, previewId: null,
        itemIds: deletion.deleted_item_ids });
      adopted.push(cleanUp(graphDeleted(operation, deletion), deletion));
    }
    return adopted;
  };
  return {
    preview: (input) => request(item('/hard-delete/preview', input), ref(input)),
    // { outcome: complete | local_pending | unknown, ...the deletion, local_stores }.
    // A refusal the graph answered (stale preview, missing confirmation) is
    // thrown: it is recorded under the operation, so it proves nothing was
    // deleted.
    async confirm(input) {
      const plan = await request(item('/hard-delete/preview', input), ref(input));
      if (plan.preview_id !== input.previewId) throw staleRefusal();
      const operation = ledger.begin({ spaceId: input.personalSpaceId, itemKind: input.itemKind, itemId: input.itemId,
        previewId: input.previewId, itemIds: plan.items.map((row) => row.item_id) });
      let answer;
      try {
        answer = await send(item('/hard-delete', input), { ...ref(input), preview_id: input.previewId,
          confirmation: input.confirmation, operation_id: operation.id }, { review: true, timeoutMs: deleteTimeoutMs });
      } catch {
        return settle(operation);
      }
      if (answer.ok) return cleanUp(graphDeleted(operation, answer.payload), answer.payload);
      if (answer.status === 410 || answer.status >= 500) return settle(operation);
      notDeleted(operation, answer.payload?.detail?.code ?? null);
      throw providerRefusal(answer.status, answer.payload);
    },
    // Where this item's delete stands, finishing what is left: the retry of
    // a page that does not know, and an old link's page.
    async status(input) {
      const operation = ledger.find(input.personalSpaceId, input.itemId);
      if (operation && ['pending', 'graph_deleted'].includes(operation.state)) return resume(operation);
      const status = await request(item('/hard-delete/status', input), ref(input));
      if (status.state !== 'deleted') {
        return { outcome: status.state === 'present' ? 'not_deleted' : 'missing', item_kind: input.itemKind, item_id: input.itemId };
      }
      // Deleted from another console, or already complete here: clean up again.
      const known = operation ?? ledger.begin({ spaceId: input.personalSpaceId, itemKind: input.itemKind,
        itemId: input.itemId, previewId: null, itemIds: status.deletion.deleted_item_ids });
      return cleanUp(graphDeleted(known, status.deletion), status.deletion);
    },
    // Console start: every operation left open by a lost answer or a crash,
    // and every graph deletion this record lost.
    async reconcile() {
      const results = [];
      for (const operation of ledger.open()) {
        try { results.push(await resume(operation)); } catch { results.push(unknown(operation)); }
      }
      try { results.push(...await adoptGraphDeletions()); } catch { /* the graph answers on a later start */ }
      return results;
    }
  };
}

// Each local store forgets on its own; one that fails is reported, not hidden.
function forgetLocally(stores, spaceId, itemIds) {
  const references = knowledgeReferences({ itemIds,
    candidateKeys: itemIds.flatMap((id) => [`entity:${id}`, `relationship:${id}`]) });
  return stores.map(({ name, forget }) => {
    try {
      return { store: name, status: 'forgotten', changed: forget(spaceId, references) };
    } catch (error) {
      return { store: name, status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

// A store that does not exist yet holds nothing; it is not created for this.
function defaultLocalStores(dataDir) {
  const sqlite = (name, open) => ({ name, forget(spaceId, references) {
    const path = join(dataDir, name);
    if (!existsSync(path)) return 0;
    const store = open(path);
    try { return store.forgetKnowledgeItems(spaceId, references); } finally { store.close(); }
  } });
  return [
    sqlite('judgment.sqlite', (path) => new JudgmentStore(path)),
    sqlite('role-work.sqlite', (path) => new RoleWorkStore(path)),
    sqlite('role-suggestions.sqlite', (path) => new RoleSuggestionLog(path))
  ];
}

function staleRefusal() {
  return new ProviderRequestError('what this delete removes changed since the preview; read the preview again',
    { status: 409, code: 'hard_delete_preview_stale' });
}
