import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { personalHumanReviewChannel } from '../graphiti/human-review-channel.js';
import { ProviderRequestError } from '../graphiti/provider-client.js';
import { JudgmentStore } from '../judgment/store.js';
import { RoleWorkStore } from '../model-backends/role-work-store.js';
import { knowledgeReferences } from './forget-references.js';

// A person's hard delete of one knowledge item from the local console
// (rec#5 C9). The provider plans, checks the preview and deletes in one
// transaction; its routes take the human-review token this port sends
// (human-review-channel.js), so no Agent or MCP tool path can preview or
// delete. After the graph committed, the local stores that keep words about
// knowledge forget the removed items: Tonborg's judgments and receipts
// (judgment.sqlite) and handed-off work packages (role-work.sqlite).
// Only the console's loopback routes use this module; no MCP or Agent tool
// module imports it (test/knowledge-hard-delete-console.test.js).

const DELETE_TIMEOUT_MS = 5 * 60_000;

// The other local stores keep no item words or IDs, so a hard delete leaves
// them as they are: preference-delivery (scope, snapshot and frame hashes),
// transcript-capture (capture settings versions per session), the capture
// settings, previews and onboarding files, model-usage.sqlite (counts), and the
// task schedule, Agent app, employee, roundtable and peer stores (no
// knowledge items; an Agent's own roundtable messages are its records).

export function knowledgeHardDelete(dataDir, {
  send = personalHumanReviewChannel(dataDir),
  localStores = defaultLocalStores(dataDir)
} = {}) {
  const item = (path, input) => `/v1/knowledge/items/${encodeURIComponent(input.itemId)}${path}`;
  const request = async (path, body, timeoutMs) => {
    const { ok, status, payload } = await send(path, body, { review: true, timeoutMs });
    if (ok) return payload;
    throw providerRefusal(status, payload);
  };
  return {
    preview: (input) => request(item('/hard-delete/preview', input),
      { personal_space_id: input.personalSpaceId, item_kind: input.itemKind }),
    async confirm(input) {
      const deleted = await request(item('/hard-delete', input), {
        personal_space_id: input.personalSpaceId, item_kind: input.itemKind,
        preview_id: input.previewId, confirmation: input.confirmation }, DELETE_TIMEOUT_MS);
      return { ...deleted, local_stores: forgetLocally(localStores, input.personalSpaceId, deleted) };
    }
  };
}

// Each local store forgets on its own; one that fails is reported, not hidden.
function forgetLocally(stores, spaceId, deleted) {
  const references = knowledgeReferences({ itemIds: deleted.deleted_item_ids,
    candidateKeys: deleted.deleted_item_ids.flatMap((id) => [`entity:${id}`, `relationship:${id}`]) });
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

function providerRefusal(status, payload) {
  const detail = payload?.detail;
  const code = typeof detail?.code === 'string' ? detail.code : status >= 500 ? 'provider_http_5xx' : 'provider_error';
  const message = typeof detail?.message === 'string' ? detail.message
    : typeof detail === 'string' && status < 500 ? detail : `The graph provider answered HTTP ${status}`;
  const deletedAt = typeof detail?.deleted_at === 'string' ? detail.deleted_at : undefined;
  return new ProviderRequestError(message, { status, code, details: deletedAt ? { deletedAt } : null });
}
