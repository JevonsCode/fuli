// A synthetic personal graph for the console side of a permanent delete
// (rec#5 C9): it answers the preview, delete and status routes the console
// port sends, keeps whether the delete committed, and can lose its answer the
// way a timeout or a crash would. Synthetic IDs only; nothing is sent anywhere.

export const PREVIEW_ID = 'a'.repeat(64);

export function syntheticGraph({ itemIds = ['item-2', 'item-1', 'fact-1'], previewId = PREVIEW_ID,
  deletedAt = '2026-10-22T01:02:03Z' } = {}) {
  const state = { deleted: false, calls: [], answerDelete: 'ok', statusDown: false };
  const record = () => ({ deletion_id: 'deletion-1', item_kind: 'entity', item_id: itemIds[0], deleted_at: deletedAt,
    deleted_by: 'user', counts: { items: itemIds.length, episodes: 1 }, deleted_item_ids: [...itemIds] });
  const reply = (status, payload) => ({ ok: status < 400, status, payload });
  state.send = async (path, payload, options) => {
    state.calls.push({ path, payload, review: options?.review === true });
    if (path.endsWith('/hard-delete/preview')) {
      return state.deleted ? reply(410, { detail: { code: 'hard_deleted', message: 'deleted', deleted_at: deletedAt } })
        : reply(200, { preview_id: previewId, item_kind: 'entity', item_id: itemIds[0], title: 'Synthetic title',
          items: itemIds.map((item_id) => ({ item_id })), counts: {} });
    }
    if (path.endsWith('/hard-delete/status')) {
      if (state.statusDown) throw new Error('synthetic provider unreachable');
      return reply(200, state.deleted ? { state: 'deleted', deletion: record() } : { state: 'present', deletion: null });
    }
    if (path.endsWith('/hard-delete')) {
      switch (state.answerDelete) {
        case 'ok': state.deleted = true; return reply(200, record());
        // The graph committed; the answer never reached the console.
        case 'lost': state.deleted = true; throw new Error('synthetic timeout after the commit');
        // The request never reached the graph.
        case 'down': throw new Error('synthetic provider unreachable');
        case 'gone': return reply(410, { detail: { code: 'hard_deleted', message: 'deleted', deleted_at: deletedAt } });
        case 'refused': return reply(422, { detail: { code: 'hard_delete_unconfirmed', message: 'type 删除' } });
        default: throw new Error(`unknown answer ${state.answerDelete}`);
      }
    }
    throw new Error(`unexpected provider path ${path}`);
  };
  state.record = record;
  return state;
}
