import { setTimeout as delay } from 'node:timers/promises';

// A synthetic personal graph for the console side of a permanent delete
// (rec#5 C9): it answers the preview, delete, operation, abort, status and
// list routes the console port sends, and keeps each operation's outcome the
// way the provider does. Like the provider, a delete holds the space's lock
// from arrival to commit and an abort takes the same lock, so an abort waits
// for a delete that still runs. It can lose its answer, hold a delete's
// transaction past the console's timeout, or hold a delete before it arrives,
// each until a test releases it. Synthetic IDs only; nothing is sent anywhere.

export const PREVIEW_ID = 'a'.repeat(64);

export function syntheticGraph({ itemIds = ['item-2', 'item-1', 'fact-1'], previewId = PREVIEW_ID,
  deletedAt = '2026-10-22T01:02:03Z' } = {}) {
  const state = {
    deleted: false, calls: [], operations: new Map(),
    // Each delete's provider side, so a test can wait until a held one is handled.
    deletes: [],
    // ok | lost (commits, answer lost) | down (never arrives) | gone (410) |
    // refused (422)
    answerDelete: 'ok', statusDown: false,
    // Set to a promise to hold the next delete before it arrives; the test
    // resolves it to let the delete reach the graph.
    arriveWhen: null,
    // Set to a promise to hold the delete's transaction, and the space's lock,
    // after it arrived; the test resolves it to let the delete commit.
    commitWhen: null
  };
  let lock = Promise.resolve();
  const withLock = (work) => {
    const run = lock.then(work);
    lock = run.catch(() => {});
    return run;
  };
  const record = () => ({ deletion_id: 'deletion-1', item_kind: 'entity', item_id: itemIds[0], deleted_at: deletedAt,
    deleted_by: 'user', counts: { items: itemIds.length, episodes: 1 }, deleted_item_ids: [...itemIds] });
  const reply = (status, payload) => ({ ok: status < 400, status, payload });
  const refuse = (operationId, status, code) => {
    if (operationId && !state.operations.has(operationId)) state.operations.set(operationId, { state: 'refused', code });
    return reply(status, { detail: { code, message: code, ...(status === 410 ? { deleted_at: deletedAt } : {}) } });
  };
  // The provider's side of one delete, from arrival to its answer.
  const arrive = async (operationId) => {
    if (state.arriveWhen) await state.arriveWhen;
    return withLock(async () => {
      const known = state.operations.get(operationId);
      if (known?.state === 'aborted') return refuse(operationId, 409, 'hard_delete_aborted');
      if (state.answerDelete === 'gone' || state.deleted) return refuse(operationId, 410, 'hard_deleted');
      if (state.answerDelete === 'refused') return refuse(operationId, 422, 'hard_delete_unconfirmed');
      if (state.commitWhen) await state.commitWhen;
      state.deleted = true;
      state.operations.set(operationId, { state: 'committed' });
      return reply(200, record());
    });
  };
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
    const operation = path.match(/^\/v1\/knowledge\/hard-delete-operations\/([^/]+)(\/abort)?$/);
    if (operation) {
      if (state.statusDown) throw new Error('synthetic provider unreachable');
      const [, id, abort] = operation;
      const answer = () => {
        const known = state.operations.get(id);
        return reply(200, { operation_id: id, state: known?.state ?? 'unknown', code: known?.code ?? null,
          deletion: known?.state === 'committed' ? record() : null });
      };
      if (!abort) return answer();
      return withLock(async () => {
        if (!state.operations.has(id)) state.operations.set(id, { state: 'aborted', code: 'aborted' });
        return answer();
      });
    }
    if (path === '/v1/knowledge/hard-deletions') return reply(200, state.deleted ? [record()] : []);
    if (path.endsWith('/hard-delete')) {
      if (state.answerDelete === 'down') throw new Error('synthetic provider unreachable');
      const answered = arrive(payload.operation_id);
      state.deletes.push(answered);
      if (state.answerDelete === 'lost') {
        await answered;
        throw new Error('synthetic timeout after the commit');
      }
      // The client stops waiting after its timeout; the graph goes on.
      const stop = new AbortController();
      const timeout = delay(options?.timeoutMs ?? 300_000, undefined, { signal: stop.signal }).then(() => {
        throw new Error('synthetic client timeout');
      }, () => new Promise(() => {}));
      try {
        return await Promise.race([answered, timeout]);
      } finally {
        stop.abort();
      }
    }
    throw new Error(`unexpected provider path ${path}`);
  };
  state.record = record;
  return state;
}
