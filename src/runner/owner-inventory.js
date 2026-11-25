import { createHash, randomUUID } from 'node:crypto';

import { grantScope } from './scope-grants.js';

export const INVENTORY_PAGE = 64;
const MAX_PAGES = 64;
const MAX_PEERS = 16;
const SNAPSHOT_TTL = 120_000;
const invalid = code => ({ ok: false, code });

export function inventoryDigest(ids) {
  const sorted = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export function inventoryPages(spaceId, ids, snapshot = randomUUID()) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length > INVENTORY_PAGE * MAX_PAGES) throw new RangeError('Project inventory is too large');
  const count = Math.max(1, Math.ceil(sorted.length / INVENTORY_PAGE));
  return Array.from({ length: count }, (_, page) => ({ version: 1, spaceId, snapshot, page, count,
    projects: sorted.slice(page * INVENTORY_PAGE, (page + 1) * INVENTORY_PAGE) }));
}

// A complete authenticated report records claims. Only proof from that same
// device, checked by the local Provider, can turn them into verified ownership.
export function ownerInventory({ spaceId, registry, pairing = () => true, now = Date.now }) {
  const snapshots = new Map();
  function accept(device, input) {
    for (const [id, state] of snapshots) if (state.until <= now()) snapshots.delete(id);
    const epoch = pairing(device);
    if (!epoch || !input || input.spaceId !== spaceId() || input.version !== 1 || !/^[a-f0-9-]{36}$/i.test(input.snapshot ?? '') ||
      !Number.isInteger(input.count) || input.count < 1 || input.count > MAX_PAGES || !Number.isInteger(input.page) ||
      input.page < 0 || input.page >= input.count || !Array.isArray(input.projects) || input.projects.length > INVENTORY_PAGE ||
      !input.projects.every(id => typeof id === 'string' && grantScope('project:' + id) === 'project:' + id)) {
      return invalid('inventory_invalid');
    }
    let state = snapshots.get(device);
    if (state && state.epoch !== epoch) {
      snapshots.delete(device);
      state = null;
    }
    if (state?.snapshot !== input.snapshot) {
      if (input.page !== 0 || (state && !state.complete) || (!state && snapshots.size >= MAX_PEERS)) {
        return invalid('inventory_restart_needed');
      }
      const retired = state?.retired ?? new Map();
      for (const [id, until] of retired) if (until <= now()) retired.delete(id);
      if (retired.has(input.snapshot) || retired.size >= 64) return invalid('inventory_restart_needed');
      if (state) retired.set(state.snapshot, now() + SNAPSHOT_TTL);
      state = { retired, epoch, snapshot: input.snapshot, space: input.spaceId, count: input.count, pages: new Map(), until: now() + SNAPSHOT_TTL };
      snapshots.set(device, state);
    }
    if (state.space !== input.spaceId || state.count !== input.count) return invalid('inventory_changed');
    const previous = state.pages.get(input.page);
    if (previous && JSON.stringify(previous) !== JSON.stringify(input.projects)) return invalid('inventory_changed');
    state.pages.set(input.page, input.projects);
    if (!state.complete && state.pages.size === state.count) {
      const ids = [...state.pages.values()].flat();
      if (new Set(ids).size !== ids.length) return invalid('inventory_duplicate');
      registry().reported(device, ids);
      state.complete = ids;
    }
    return { ok: true, complete: Boolean(state.complete) };
  }
  return {
    accept,
    pending(device) {
      const state = snapshots.get(device);
      if (!state?.complete || state.epoch !== pairing(device) || state.space !== spaceId() || state.until <= now()) return null;
      return { snapshot: state.snapshot, projects: [...state.complete] };
    },
    verified(device, snapshot, proofs, catalog) {
      const state = snapshots.get(device);
      if (!state || state.epoch !== pairing(device) || state.snapshot !== snapshot || !state.complete || state.space !== spaceId() || state.until <= now() ||
        catalog?.digest !== inventoryDigest(state.complete) || catalog.count !== state.complete.length ||
        proofs.length !== state.complete.length || new Set(proofs.map(item => item.project)).size !== proofs.length ||
        !proofs.every(item => state.complete.includes(item.project) && item.spaceId === state.space && item.owner === device &&
          /^[a-f0-9]{64}$/.test(item.digest))) return invalid('inventory_changed');
      return registry().verified(device, state.complete);
    },
    keep(devices) {
      for (const device of snapshots.keys()) if (!devices.has(device)) snapshots.delete(device);
    }
  };
}
