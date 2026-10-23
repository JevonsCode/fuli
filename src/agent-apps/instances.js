import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createAppTokens } from './app-tokens.js';
import { createDataDeletion } from './data-deletion.js';
import { ensureDataDirectory } from './data-directory.js';
import { appConflict } from './errors.js';
import { createRunGate, runRefused } from './run-gate.js';
import { LIVE_INSTANCE_STATES } from './store.js';

const INSTANCE_ID_BYTES = 16;
// Sealing waits this long for a write tool that holds the gate (D-28.17).
const SEAL_WAIT_MS = 10_000;

// Waits ms unless aborted; resolves either way.
const waitFor = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

// The app runner (rec#7 D-28.9, D-28.14, D-28.17): the one current instance
// of each app this process hosts, and the serial contract around it.
// - start: the run gate and the isolation self-check pass, the owner lease is
//   taken for the instance's life, and inside the write gate the next instance
//   generation is claimed, the data root is created (the only place it is),
//   a token bound to the instance is issued and the backend starts it.
// - seal: stopping (no new call verifies) → sealing (a write tool still holds
//   the gate after 10 s; every decision on the app answers instance_sealing
//   until it ends) → sealed (sealedAt written inside the gate). Then the
//   process stops through the backend's own reference, the tokens end and
//   the lease is released.
// - reconcile, before every operation: an instance whose host has exited
//   (its lease was just taken over on exit evidence) is stopped through the
//   backend and sealed with reason host_gone, which also completes a sealing
//   its host left; an interrupted data deletion is settled.
export function createAppInstances(context) {
  const { store, leases, gates, isolation, now } = context;
  const wait = context.wait ?? waitFor;
  const tokens = createAppTokens(context);
  const { runGate } = createRunGate(context);
  const deletion = createDataDeletion(context);
  const hosted = new Map();

  async function start({ appId, mode = 'managed' }) {
    const gate = runGate({ appId });
    if (gate.status !== 'ready') return gate;
    const check = await isolation.selfCheck();
    if (!check.ok) return runRefused('isolation_probe_failed');
    const lease = await leases.acquire(appId);
    try {
      return await gates.run(appId, { toolName: 'start', since: now() }, async () => {
        await reconcile(appId, lease);
        return await launch(appId, mode, lease);
      });
    } catch (error) {
      leases.release(lease);
      throw error;
    }
  }

  async function launch(appId, mode, lease) {
    const earlier = store.instance(appId);
    if (earlier && LIVE_INSTANCE_STATES.includes(earlier.state)) throw liveInstance(earlier);
    const instanceId = `ins-${randomBytes(INSTANCE_ID_BYTES).toString('hex')}`;
    const opened = store.transaction(() => {
      leases.assertOwned(lease);
      const app = store.existingApp(appId);
      if (app.status !== 'active') return { refusal: appConflict('app_not_active', 'Only an active app with an approved version runs') };
      const generation = store.claimInstanceGeneration(appId, app.instanceGeneration);
      if (generation === null) return { refusal: superseded() };
      const minted = tokens.mintToken({ app, instanceId, generation });
      if (minted.refusal) return minted;
      const version = store.version(appId, app.activeVersion);
      store.insertInstance({ appId, instanceId, generation, mode, version: version.version, digest: version.digest,
        ownerId: lease.ownerId, startedAt: now() });
      store.recordEvent({ appId, at: now(), action: 'instance_started', version: version.version,
        detail: { instanceId, generation, mode } });
      return { generation, version, token: minted.token };
    });
    if (opened.refusal) throw opened.refusal;
    const { generation, version, token } = opened;
    const instance = { instanceId, generation };
    let handle;
    try {
      if (version.manifest.data.scope === 'app') {
        leases.assertOwned(lease);
        ensureDataDirectory(context.dataOf(appId));
      }
      handle = await isolation.start({ appId, instanceId, generation, mode, manifest: version.manifest,
        packageDirectory: context.packageOf(appId, version.version), dataDirectory: context.dataOf(appId),
        environment: { FULI_APP_ID: appId, FULI_APP_INSTANCE: instanceId, FULI_APP_TOKEN: token } });
    } catch (error) {
      endInstance(appId, lease, instance, 'start_failed', { sealedAt: now() });
      throw error;
    }
    const recorded = store.transaction(() => {
      leases.assertOwned(lease);
      return store.updateInstance(instance, { pid: handle.pid ?? null, pidIdentity: handle.pidIdentity ?? null,
        exePath: handle.exePath ?? null, socket: handle.socket ?? null });
    });
    if (!recorded) {
      await isolation.stop(handle);
      throw superseded();
    }
    hosted.set(appId, { lease, ...instance, handle, sealing: null });
    return { status: 'running', appId, instanceId, generation, version: version.version, mode };
  }

  // Seals and stops this process's instance of the app. Resolves sealed, or
  // sealing when a write tool still holds the gate after the wait; the seal
  // then completes by itself when that tool ends.
  function seal(appId, reason) {
    const local = hosted.get(appId);
    if (!local) return Promise.resolve({ status: 'not_running' });
    local.sealing ??= sealHosted(appId, local, reason);
    return local.sealing;
  }

  function sealHosted(appId, local, reason) {
    const { lease } = local;
    store.transaction(() => {
      leases.assertOwned(lease);
      store.updateInstance(local, { state: 'stopping' });
      store.recordEvent({ appId, at: now(), action: 'stopping', detail: { instanceId: local.instanceId, reason } });
    });
    const asked = context.clock().getTime();
    const entry = gates.enter(appId, { toolName: 'seal', since: now() });
    const done = entry.then((leave) => finishSeal(appId, local, reason, leave));
    // When the seal completes after the caller was told sealing, a failure
    // (this process lost the lease) is left to the next owner's reconcile.
    done.catch(() => {});
    const timeout = new AbortController();
    const outcome = Promise.race([done.then(() => 'sealed'), wait(SEAL_WAIT_MS, timeout.signal).then(() => 'waiting')])
      .then((state) => {
        timeout.abort();
        if (state === 'sealed') return { status: 'sealed', appId, instanceId: local.instanceId };
        const holder = gates.holder(appId);
        store.transaction(() => {
          if (!leases.owns(lease) || store.instance(appId)?.state !== 'stopping') return;
          store.updateInstance(local, { state: 'sealing' });
          store.recordEvent({ appId, at: now(), action: 'seal_waiting_for_writes', detail: { taskId: holder?.taskId ?? null,
            toolName: holder?.toolName ?? null, elapsed: context.clock().getTime() - asked } });
        });
        return { status: 'sealing', appId, instanceId: local.instanceId, waitingFor: holder?.toolName ?? null };
      });
    return outcome;
  }

  async function finishSeal(appId, local, reason, leave) {
    try {
      try {
        store.transaction(() => {
          leases.assertOwned(local.lease);
          store.updateInstance(local, { state: 'sealed', sealedAt: now() });
          store.recordEvent({ appId, at: now(), action: 'sealed', detail: { instanceId: local.instanceId, reason } });
        });
      } finally {
        leave();
      }
      await isolation.stop(local.handle);
      endInstance(appId, local.lease, local, reason);
    } finally {
      hosted.delete(appId);
      leases.release(local.lease);
    }
  }

  // The tokens end and the instance records its stop; it is sealed by now,
  // or never ran (a failed start).
  function endInstance(appId, lease, instance, reason, fields = {}) {
    store.transaction(() => {
      leases.assertOwned(lease);
      store.revokeTokens(appId, reason, now());
      store.updateInstance(instance, { ...fields, state: 'sealed', stoppedAt: now(), stopReason: reason });
      store.recordEvent({ appId, at: now(), action: 'stopped', detail: { instanceId: instance.instanceId, reason } });
    });
  }

  // Before a decision on the app: this process's instance is sealed and stopped first.
  async function end(appId, reason) {
    const sealed = await seal(appId, reason);
    if (sealed.status === 'sealing') throw sealingRefusal(sealed);
  }

  // fuli app stop: this process's instance, or one whose host has exited
  // (taken over on exit evidence). force against a live host is refused.
  async function stop({ appId, force = false }) {
    if (hosted.has(appId)) {
      const sealed = await seal(appId, 'stopped');
      if (sealed.status === 'sealing') throw sealingRefusal(sealed);
      return sealed;
    }
    const lease = await leases.acquire(appId, { force });
    try {
      await gates.run(appId, { toolName: 'stop', since: now() }, () => reconcile(appId, lease));
      return { status: 'stopped', appId, instance: store.instance(appId)?.state ?? null };
    } finally {
      leases.release(lease);
    }
  }

  // Inside the app's write gate, holding its lease.
  async function reconcile(appId, lease) {
    const instance = store.instance(appId);
    if (instance && LIVE_INSTANCE_STATES.includes(instance.state) && instance.ownerId !== lease.ownerId) {
      await isolation.stopOrphan(instance);
      // A sealing the exited host left completes here.
      if (!instance.sealedAt) {
        store.transaction(() => {
          leases.assertOwned(lease);
          store.recordEvent({ appId, at: now(), action: 'sealed', detail: { instanceId: instance.instanceId, reason: 'host_gone' } });
        });
      }
      endInstance(appId, lease, instance, 'host_gone', { sealedAt: instance.sealedAt ?? now() });
    }
    await deletion.settle(appId, lease);
  }

  // Refuses an operation while an instance has not ended.
  function assertNoInstance(appId) {
    const instance = store.instance(appId);
    if (instance && LIVE_INSTANCE_STATES.includes(instance.state)) throw liveInstance(instance);
  }

  return {
    start, stop, seal, end, reconcile, assertNoInstance, verifyToken: tokens.verifyToken,
    hosted: (appId) => hosted.get(appId) ?? null
  };
}

function liveInstance(instance) {
  return instance.state === 'running'
    ? appConflict('instance_running', 'The app is running; stop it first', { instanceId: instance.instanceId })
    : appConflict('instance_sealing', 'The app is being stopped and waits for a write tool to finish',
      { instanceId: instance.instanceId, state: instance.state });
}

function sealingRefusal({ instanceId, waitingFor }) {
  return appConflict('instance_sealing', `The app is being stopped and waits for ${waitingFor ?? 'a write tool'} to finish; `
    + 'try again when it has', { instanceId, waitingFor });
}

const superseded = () => appConflict('instance_superseded', 'Another start of this app superseded this one');
