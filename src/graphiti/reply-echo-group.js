import { InvalidInputError } from '../app/application-error.js';
import { replyEchoSignals } from './reply-echo.js';

// 「之前误存的 Agent 回复」 in 待决策 (reply-echo.js): the items found, and the
// person's drop of them together. Dropping is the existing drop (the item
// stops being current, invalidate); restoring makes each current again, so
// nothing asks twice. Only items that are still found are dropped, whatever
// the request names: the group can never reach anything else.

const PAGE = 500;
// One request's items: within the console's 64 KiB body limit.
export const MAX_ITEMS = 500;
const ITEM_KINDS = new Set(['entity', 'relationship']);
export const DROP_REASON = '之前误存的 Agent 回复：全部丢掉';
export const RESTORE_REASON = '撤销「之前误存的 Agent 回复」的全部丢掉';

// readPage(limit, offset): one page of the Provider's graph read, as the
// caller may read it (the console's full read, or an Agent's own).
export async function findReplyEchoes(readPage) {
  const found = new Map();
  let offset = null;
  for (;;) {
    const page = await readPage(PAGE, offset);
    for (const [items, itemKind] of [[page?.nodes ?? [], 'entity'], [page?.edges ?? [], 'relationship']]) {
      for (const item of items) {
        const signals = replyEchoSignals(item, itemKind);
        if (signals) found.set(`${itemKind}:${item.id}`, { itemKind, itemId: item.id, signals, item });
      }
    }
    const next = page?.next_offset;
    if (!page?.truncated || !Number.isInteger(next) || next <= (offset ?? 0)) break;
    offset = next;
  }
  return [...found.values()];
}

// Drops the named items that are still reply echoes, one after another; an
// item that failed stays pending and is named. relayed: an FLA's relay of the
// person's words (delegation-header.js), kept in the reason.
export async function dropReplyEchoes(app, readPage, { personalSpaceId, items }, relayed = null) {
  const wanted = itemKeys(items);
  const found = new Map((await findReplyEchoes(readPage)).map(echo => [`${echo.itemKind}:${echo.itemId}`, echo]));
  const reason = relayed ? `${DROP_REASON}（由 ${relayed.relayedBy ?? 'FLA'} 转达：「${relayed.personWords}」）` : DROP_REASON;
  return change(app, personalSpaceId, wanted.filter(key => found.has(key)), 'invalidate', reason,
    { skipped: wanted.filter(key => !found.has(key)).map(splitKey) });
}

// Makes dropped items current again (the 撤销 of a drop).
export async function restoreReplyEchoes(app, { personalSpaceId, items }, relayed = null) {
  const reason = relayed ? `${RESTORE_REASON}（由 ${relayed.relayedBy ?? 'FLA'} 转达：「${relayed.personWords}」）` : RESTORE_REASON;
  return change(app, personalSpaceId, itemKeys(items), 'restore', reason, {});
}

async function change(app, personalSpaceId, keys, action, reason, extra) {
  const done = [];
  const failed = [];
  for (const key of keys) {
    const { itemKind, itemId } = splitKey(key);
    try {
      await app.reviseKnowledgeItem({ personalSpaceId, personalProjectId: null, itemKind, itemId, action, reason,
        operationActor: 'human' });
      done.push({ itemKind, itemId });
    } catch (error) {
      failed.push({ itemKind, itemId, code: error?.code ?? 'error' });
    }
  }
  return { [action === 'invalidate' ? 'dropped' : 'restored']: done, failed, ...extra };
}

function itemKeys(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
    throw new InvalidInputError(`items takes 1 to ${MAX_ITEMS} { itemKind, itemId }`);
  }
  return [...new Set(items.map((item) => {
    if (!ITEM_KINDS.has(item?.itemKind) || typeof item.itemId !== 'string' || !item.itemId || item.itemId.length > 256) {
      throw new InvalidInputError('each item is { itemKind: entity | relationship, itemId }');
    }
    return `${item.itemKind}:${item.itemId}`;
  }))];
}

function splitKey(key) {
  const at = key.indexOf(':');
  return { itemKind: key.slice(0, at), itemId: key.slice(at + 1) };
}
