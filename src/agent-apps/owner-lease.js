import { randomBytes } from 'node:crypto';

import { appConflict } from './errors.js';
import { createWriteGates } from './write-gate.js';

// While held, the lease is refreshed this often; the heartbeat is for display
// and instance_unresponsive only and never lets another process take over.
const HEARTBEAT_MS = 5000;
const UNRESPONSIVE_AFTER_MS = 30_000;
// A takeover whose owner row changed under the probe is tried once more.
const ACQUIRE_ATTEMPTS = 2;

// The owner lease of each app in the shared registry (rec#7 D-28.21, D-28.25,
// D-28.26). One FULI process at a time (console, standalone runner or CLI)
// may change an app or its data: an instance holds the lease from its start
// until it is sealed and stopped; any other operation holds it for its own
// run. Taking the lease raises the app's fence. Every write transaction and
// every data file operation of a holder first compares the stored owner and
// fence with its own (assertOwned) and writes nothing when they differ.
//
// A lease held by another process is taken over only on exit evidence: the
// owner row is read, the owner process is probed (host-identity.js, which may
// take a while), and inside BEGIN IMMEDIATE the row is read again and must be
// unchanged column for column. alive and unknown refuse; a heartbeat older
// than 30 s only changes the refusal to instance_unresponsive. This version
// never stops another FULI process: --force against a live owner is refused
// with stop_force_unsupported and nothing is signalled (D-28.29, rec#11 D-36).
export function createOwnerLeases({ store, hostIdentity, ownerKind, clock, now, timers = globalThis }) {
  const ownerId = `own-${randomBytes(16).toString('hex')}`;
  const held = new Map();
  let self = null;

  function owns({ appId, ownerId: holder, fence }) {
    const owner = store.owner(appId);
    return owner.ownerId === holder && owner.fence === fence;
  }

  // A process that lost its lease to another one records nothing more; one
  // whose lease simply ended may still note what happened to a late call.
  function mayRecord({ appId, ownerId: holder }) {
    const { ownerId: current } = store.owner(appId);
    return current === null || current === holder;
  }

  function assertOwned(lease) {
    if (!owns(lease)) {
      throw appConflict('write_fenced', 'Another FULI process took over this app; this one writes nothing more for it');
    }
  }

  // Acquires of one app in this process run one after another, so a second
  // one waits for the first and then shares its lease (holders + 1) instead
  // of taking the lease again and fencing out the first.
  const acquiring = createWriteGates();

  function acquire(appId, options = {}) {
    return acquiring.run(appId, { toolName: 'acquire' }, () => acquireNow(appId, options));
  }

  async function acquireNow(appId, { force = false }) {
    const me = await (self ??= hostIdentity.self());
    for (let attempt = 1; ; attempt += 1) {
      const local = held.get(appId);
      if (local) {
        assertOwned(local.lease);
        local.holders += 1;
        return local.lease;
      }
      const outcome = await takeLease(appId, me, { force });
      if (outcome.fence !== undefined) return remember(appId, outcome.fence);
      if (attempt >= ACQUIRE_ATTEMPTS) throw outcome.refusal;
    }
  }

  async function takeLease(appId, me, { force }) {
    const snapshot = store.owner(appId);
    const holder = { ownerId, ownerKind, pid: me.pid, identity: me.identity, exePath: me.exePath };
    if (!snapshot.ownerId || snapshot.ownerId === ownerId) {
      const fence = store.transaction(() => (sameOwner(store.owner(appId), snapshot)
        ? store.takeOwner(appId, { ...holder, at: now() }) : null));
      return fence === null ? changed(appId, snapshot) : { fence };
    }
    const verdict = await hostIdentity.probe({ pid: snapshot.pid, identity: snapshot.identity });
    if (verdict === 'alive' && force) throw forceUnsupported(snapshot);
    if (verdict !== 'exited') throw refusedTakeover(appId, snapshot, verdict);
    const fence = store.transaction(() => {
      if (!sameOwner(store.owner(appId), snapshot)) return null;
      const taken = store.takeOwner(appId, { ...holder, at: now() });
      store.recordEvent({ appId, at: now(), action: 'owner_recovered',
        detail: { from: { ownerKind: snapshot.ownerKind, pid: snapshot.pid }, reason: 'host_gone', fence: taken } });
      return taken;
    });
    return fence === null ? changed(appId, snapshot) : { fence };
  }

  function changed(appId, snapshot) {
    store.recordEvent({ appId, at: now(), action: 'takeover_refused',
      detail: { reason: 'owner_changed', ownerKind: snapshot.ownerKind, pid: snapshot.pid } });
    return { refusal: appConflict('app_owned_elsewhere', 'Another FULI process took this app at the same time; try again',
      { reason: 'owner_changed' }) };
  }

  function forceUnsupported(snapshot) {
    return appConflict('stop_force_unsupported', 'FULI does not stop another FULI process. Stop that host first (quit the '
      + 'console, or Ctrl-C the standalone runner) and try again; FULI takes over once it has verified the exit '
      + '(请先停止该宿主后重试，FULI 核实其退出后会自动接管).', { platform: hostIdentity.platform, ownerKind: snapshot.ownerKind,
      ownerPid: snapshot.pid, reason: 'no_stable_process_reference' });
  }

  function refusedTakeover(appId, snapshot, verdict) {
    const reason = verdict === 'alive' ? 'owner_alive' : 'owner_unverifiable';
    const detail = { reason, ownerKind: snapshot.ownerKind, pid: snapshot.pid, since: snapshot.acquiredAt };
    store.transaction(() => store.recordEvent({ appId, at: now(), action: 'takeover_refused', detail }));
    const stale = verdict === 'alive' && snapshot.heartbeatAt
      && clock().getTime() - Date.parse(snapshot.heartbeatAt) > UNRESPONSIVE_AFTER_MS;
    if (stale) {
      return appConflict('instance_unresponsive', `The ${snapshot.ownerKind} process ${snapshot.pid} that holds this app is `
        + 'running but has not reported for over 30 seconds; stop that process first', detail);
    }
    return appConflict('app_owned_elsewhere', verdict === 'alive'
      ? `The ${snapshot.ownerKind} process ${snapshot.pid} holds this app; stop the app there or with fuli app stop`
      : `FULI cannot verify whether the ${snapshot.ownerKind} process ${snapshot.pid} that holds this app has exited, so it `
        + 'does not take the app over', detail);
  }

  function remember(appId, fence) {
    const lease = Object.freeze({ appId, ownerId, fence });
    const heartbeat = timers.setInterval(() => {
      if (!store.heartbeatOwner(appId, lease, now())) timers.clearInterval(heartbeat);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    held.set(appId, { lease, holders: 1, heartbeat });
    return lease;
  }

  // The holder count of this process drops; the last holder clears the owner
  // in one transaction, only while the lease is still its own.
  function release(lease) {
    const local = held.get(lease.appId);
    if (!local || local.lease !== lease) return;
    local.holders -= 1;
    if (local.holders > 0) return;
    held.delete(lease.appId);
    timers.clearInterval(local.heartbeat);
    store.transaction(() => store.clearOwner(lease.appId, lease));
  }

  function close() {
    for (const { heartbeat } of held.values()) timers.clearInterval(heartbeat);
    held.clear();
  }

  return { ownerId, acquire, release, owns, mayRecord, assertOwned, close };
}

const sameOwner = (left, right) => left.ownerId === right.ownerId && left.fence === right.fence
  && left.pid === right.pid && left.identity === right.identity;
