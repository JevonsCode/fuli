import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { personalHumanReviewChannel } from '../graphiti/human-review-channel.js';
import { ProviderRequestError } from '../graphiti/provider-client.js';
import { JudgmentStore } from '../judgment/store.js';
import { RoleWorkStore } from '../model-backends/role-work-store.js';
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
// receipts (judgment.sqlite) and handed-off work packages (role-work.sqlite).
// Only the console's loopback routes use this module; no MCP or Agent tool
// module imports it (test/knowledge-hard-delete-console.test.js).

const DELETE_TIMEOUT_MS = 5 * 60_000;
// After this long an item that is still there was not deleted by the
// operation that waited: its transaction ended, committed or not, long ago.
const UNKNOWN_WINDOW_MS = 2 * DELETE_TIMEOUT_MS;

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
  ledger = hardDeleteLedger(dataDir, { now })
} = {}) {
  const item = (path, input) => `/v1/knowledge/items/${encodeURIComponent(input.itemId)}${path}`;
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
  // A pending operation's outcome, from the graph: never by sending the
  // irreversible delete again.
  const settle = async (operation) => {
    let status;
    try {
      status = await request(item('/hard-delete/status', { itemId: operation.itemId }),
        { personal_space_id: operation.spaceId, item_kind: operation.itemKind });
    } catch {
      return unknown(operation);
    }
    if (status.state === 'deleted') return cleanUp(graphDeleted(operation, status.deletion), status.deletion);
    // The item is still there long after any delete could have committed.
    if (status.state === 'present' && now() - Date.parse(operation.createdAt) > UNKNOWN_WINDOW_MS) {
      ledger.update(operation.id, { state: 'not_deleted' });
      return { outcome: 'not_deleted', item_kind: operation.itemKind, item_id: operation.itemId };
    }
    return unknown(operation);
  };
  const resume = (operation) => operation.state === 'pending' ? settle(operation)
    : cleanUp(operation, { deletion_id: operation.deletionId, item_kind: operation.itemKind, item_id: operation.itemId,
      deleted_at: operation.deletedAt, deleted_item_ids: operation.itemIds });
  return {
    preview: (input) => request(item('/hard-delete/preview', input), ref(input)),
    // { outcome: complete | local_pending | unknown, ...the deletion, local_stores }.
    // A refusal the graph answered (stale preview, missing confirmation) is
    // thrown: only that proves nothing was deleted.
    async confirm(input) {
      const plan = await request(item('/hard-delete/preview', input), ref(input));
      if (plan.preview_id !== input.previewId) throw staleRefusal();
      const operation = ledger.begin({ spaceId: input.personalSpaceId, itemKind: input.itemKind, itemId: input.itemId,
        previewId: input.previewId, itemIds: plan.items.map((row) => row.item_id) });
      let answer;
      try {
        answer = await send(item('/hard-delete', input), { ...ref(input), preview_id: input.previewId,
          confirmation: input.confirmation }, { review: true, timeoutMs: DELETE_TIMEOUT_MS });
      } catch {
        return settle(operation);
      }
      if (answer.ok) return cleanUp(graphDeleted(operation, answer.payload), answer.payload);
      if (answer.status === 410 || answer.status >= 500) return settle(operation);
      ledger.update(operation.id, { state: 'not_deleted' });
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
    // Every operation left open by a lost answer or a crash (console start).
    async reconcile() {
      const results = [];
      for (const operation of ledger.open()) {
        try { results.push(await resume(operation)); } catch { results.push(unknown(operation)); }
      }
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
    sqlite('role-work.sqlite', (path) => new RoleWorkStore(path))
  ];
}

function staleRefusal() {
  return new ProviderRequestError('what this delete removes changed since the preview; read the preview again',
    { status: 409, code: 'hard_delete_preview_stale' });
}

function providerRefusal(status, payload) {
  const detail = payload?.detail;
  const code = typeof detail?.code === 'string' ? detail.code : status >= 500 ? 'provider_http_5xx' : 'provider_error';
  const message = typeof detail?.message === 'string' ? detail.message
    : typeof detail === 'string' && status < 500 ? detail : `The graph provider answered HTTP ${status}`;
  const deletedAt = typeof detail?.deleted_at === 'string' ? detail.deleted_at : undefined;
  return new ProviderRequestError(message, { status, code, details: deletedAt ? { deletedAt } : null });
}
