import { AsyncLocalStorage } from 'node:async_hooks';

// One read of the personal project list per task entry (rec#39 D-40): the
// entry resolves its directory, and authorizes its managers, against the same
// list. A project write through the same Provider drops it, so a project the
// entry registers or creates is found afterwards. Outside an entry every read
// goes to the Provider, as before.
const entries = new AsyncLocalStorage();

export function withSharedProjectList(operation) {
  return entries.getStore() ? operation() : entries.run(new Map(), operation);
}

export function sharedProjectList(provider, personalSpaceId, read) {
  const lists = entries.getStore();
  if (!lists) return read();
  if (!lists.has(provider)) lists.set(provider, new Map());
  const own = lists.get(provider);
  if (!own.has(personalSpaceId)) {
    const pending = read();
    own.set(personalSpaceId, pending);
    // A failed read is not shared: the next caller asks again.
    pending.catch(() => { if (own.get(personalSpaceId) === pending) own.delete(personalSpaceId); });
  }
  return own.get(personalSpaceId);
}

// Before and after the write: a read that started while it ran is not kept.
export async function afterProjectWrite(provider, write) {
  entries.getStore()?.delete(provider);
  try {
    return await write();
  } finally {
    entries.getStore()?.delete(provider);
  }
}
