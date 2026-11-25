import { randomUUID } from 'node:crypto';

import { grantScope } from './scope-grants.js';

// Only one outstanding poll and one issued call per device. A call is never
// parked for a disconnected owner or issued a second time after a lost result.
export const OWNER_PROTOCOL = 1;
export const CHUNK_BYTES = 192 * 1024;
const MAX_PEERS = 16;
const ACTIONS = new Set(['catalog', 'inventory', 'export_digest', 'export_chunk', 'project_read', 'project_update', 'board_read', 'history_read']);
const failure = (code, dispatched = false) => ({ ok: false, code, dispatched });
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validOwnerCall(call) {
  return validKey(call?.spaceId) && (call.action === 'catalog' ? call.scope === 'global' : grantScope(call.scope)?.startsWith('project:') === true) &&
    Number.isSafeInteger(call.generation) && call.generation >= 1 && ACTIONS.has(call.action) &&
    validKey(call.requestId) && validId(call.owner);
}

export function ownerChannel({ admit, now = Date.now, pollMs = 12_000, callMs = 25_000 } = {}) {
  const waiting = new Map();
  const issued = new Map();
  let closed = false;
  function wait(map, device, timeout, signal, expired, extra = {}) {
    let finish;
    const promise = new Promise(resolve => {
      let timer;
      const cancel = () => finish(expired);
      finish = value => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        map.delete(device);
        resolve(value);
      };
      timer = setTimeout(cancel, timeout);
      timer.unref?.();
      map.set(device, { ...extra, finish });
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
    return promise;
  }
  function disconnect(device) {
    waiting.get(device)?.finish({ job: null });
    issued.get(device)?.finish(failure('owner_result_unknown', true));
  }
  return {
    pull(device, { signal } = {}) {
      if (closed || !validId(device) || signal?.aborted || issued.has(device) || waiting.has(device) ||
        waiting.size + issued.size >= MAX_PEERS) return Promise.resolve({ job: null });
      return wait(waiting, device, pollMs, signal, { job: null });
    },
    request(call, { signal } = {}) {
      if (!validOwnerCall(call) || !admit(call)) return Promise.resolve(failure('owner_request_refused'));
      const lane = waiting.get(call.owner);
      if (closed || signal?.aborted || !lane) return Promise.resolve(failure('owner_offline'));
      const job = { ...call, receiptId: randomUUID(), expiresAt: now() + callMs };
      if (Buffer.byteLength(JSON.stringify(job)) > 32_768) return Promise.resolve(failure('owner_request_too_large'));
      const answer = wait(issued, call.owner, callMs, signal, failure('owner_result_unknown', true), { job });
      lane.finish({ job });
      return answer;
    },
    reply(device, result) {
      const entry = issued.get(device);
      if (!entry || !result || entry.job.receiptId !== result.receiptId || entry.job.requestId !== result.requestId ||
        entry.job.generation !== result.generation || entry.job.spaceId !== result.spaceId || entry.job.scope !== result.scope) {
        return failure('owner_call_unknown');
      }
      if (now() >= entry.job.expiresAt || !admit(entry.job)) {
        disconnect(device);
        return failure('owner_call_changed');
      }
      if (Buffer.byteLength(JSON.stringify(result)) > CHUNK_BYTES * 2) return failure('owner_result_too_large');
      entry.finish({ ok: true, dispatched: true, result: result.value });
      return { ok: true };
    },
    disconnect,
    keep(devices) {
      for (const device of new Set([...waiting.keys(), ...issued.keys()])) if (!devices.has(device)) disconnect(device);
    },
    close() {
      closed = true;
      for (const device of new Set([...waiting.keys(), ...issued.keys()])) disconnect(device);
    }
  };
}
