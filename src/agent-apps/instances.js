import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createAppTokens } from './app-tokens.js';
import { settledWithin } from './bounded-wait.js';
import { createDataDeletion } from './data-deletion.js';
import { ensureDataDirectory } from './data-directory.js';
import { appConflict } from './errors.js';
import { createRunGate, runRefused } from './run-gate.js';

const INSTANCE_ID_BYTES = 16;
// Sealing waits this long for a write tool that holds the gate (D-28.17).
const SEAL_WAIT_MS = 10_000;
// Closing waits this long for work in flight and for each seal; an app process
// still held after it is stopped, and its records are left to the next owner.
const CLOSE_WAIT_MS = 30_000;

// An instance has ended only once its process is confirmed stopped (stoppedAt):
// sealed alone, after a runner stop that failed, still blocks a start, an
// export and a deletion until a stop or an orphan cleanup confirms it.
const unfinished = (instance) => Boolean(instance) && !instance.stoppedAt;

// What an app_exited record says of each way an app process ends
// (trusted-runner.js). Fixed text only: nothing the app wrote is recorded.
const EXIT_MESSAGES = Object.freeze({
  load_failed: 'The app ended before its entry finished loading.',
  crashed: 'The app ended with an error after it had started.',
  exited: 'The app finished and ended by itself.'
});

// Waits ms unless aborted; resolves either way.
const waitFor = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

// The app runner (rec#7 D-28.9, D-28.14, D-28.17): the one current instance
// of each app this process hosts, and the serial contract around it.
// - start: the run gate and the runner's self-check pass, the owner lease is
//   taken for the instance's life, and inside the write gate the next instance
//   generation is claimed, the data root is created (the only place it is),
//   a token bound to the instance is issued and the runner starts it.
// - seal: stopping (no new call verifies) → sealing (a write tool still holds
//   the gate after 10 s; every decision on the app answers instance_sealing
//   until it ends) → sealed (sealedAt written inside the gate). Then the
//   process stops through the runner's own reference, the tokens end and
//   the lease is released.
// - reconcile, before every operation: an instance whose host has exited
//   (its lease was just taken over on exit evidence) is confirmed stopped by the
//   runner and sealed with reason host_gone, which also completes a sealing
//   its host left; an interrupted data deletion is settled.
// - exit: an app process that ends by itself (its entry failed to load, it
//   crashed or it finished) is wrapped up in the app's lifecycle, bound to
//   its instance id and generation: recorded with a short redacted summary
//   and sealed like a stop. An exit of an earlier instance touches nothing.
// - close: no new start, stop, decision or call is admitted; work in flight
//   finishes, every instance this process holds is sealed and its process
//   stopped, and only then do the lease and the registry close. Every handle
//   the runner returned is held in memory until its stop succeeded, so a
//   start that returns after close began, a registration that throws or a
//   stop that failed never leaves a process nobody holds; close reports what
//   it could not stop instead of a clean close.
export function createAppInstances(context) {
  const { store, leases, gates, lifecycles, runner, now } = context;
  const wait = context.wait ?? waitFor;
  const closeWaitMs = context.closeWaitMs ?? CLOSE_WAIT_MS;
  const tokens = createAppTokens(context);
  const { runGate } = createRunGate(context);
  const deletion = createDataDeletion(context);
  const hosted = new Map();
  // Starts, stops and decisions in flight in this process, which close waits for.
  const inFlight = new Set();
  let closing = false;
  // Every runner handle not yet confirmed stopped, with the instance it was started for.
  const held = new Map();

  // Stops a handle through the runner; only a stop that succeeded lets it go.
  async function stopHandle(handle) {
    await runner.stop(handle);
    held.delete(handle);
  }

  // Once this process closes, its registry may already be closed: what a
  // late step could not record stays for the next owner's reconcile, as after a crash.
  function unlessClosed(work) {
    try {
      work();
    } catch (error) {
      if (!closing) throw error;
    }
  }

  // Work queued before close began, and calls of a closing host, are refused.
  function assertOpen() {
    if (closing) throw hostClosing();
  }

  // Admits one piece of lifecycle work unless this process is closing.
  function admit(work) {
    if (closing) return Promise.reject(hostClosing());
    const running = work();
    inFlight.add(running);
    running.then(() => inFlight.delete(running), () => inFlight.delete(running));
    return running;
  }

  // start, stop and every decision on an app (operations.js) run one at a
  // time in this process (lifecycles): a decision never runs beside a start
  // still in flight, and a start never begins while an earlier instance is
  // still being sealed or stopped.
  function start({ appId, mode = 'managed' }) {
    return admit(() => lifecycles.run(appId, { toolName: 'start' }, async () => {
      assertOpen();
      const earlier = hosted.get(appId);
      if (earlier) throw earlier.sealing ? sealingRefusal({ instanceId: earlier.instanceId, waitingFor: null })
        : liveInstance({ state: 'running', instanceId: earlier.instanceId });
      const gate = runGate({ appId });
      if (gate.status !== 'ready') return gate;
      const check = await runner.selfCheck();
      if (!check.ok) return runRefused('runner_check_failed');
      const lease = await leases.acquire(appId);
      let started = false;
      try {
        const outcome = await gates.run(appId, { toolName: 'start', since: now() }, async () => {
          await reconcile(appId, lease);
          return launch(appId, mode, lease);
        });
        started = outcome.status === 'running';
        return outcome;
      } finally {
        if (!started) unlessClosed(() => leases.release(lease));
      }
    }));
  }

  async function launch(appId, mode, lease) {
    const earlier = store.instance(appId);
    if (unfinished(earlier)) throw liveInstance(earlier);
    const instanceId = `ins-${randomBytes(INSTANCE_ID_BYTES).toString('hex')}`;
    const opened = store.transaction(() => {
      leases.assertOwned(lease);
      // The full run gate again, in the transaction that mints the token: the
      // version started is the one it accepts now, whatever changed while the
      // self-check, the lease or the gate were awaited.
      const gate = runGate({ appId });
      if (gate.status !== 'ready') return { gate };
      const app = store.existingApp(appId);
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
    if (opened.gate) return opened.gate;
    if (opened.refusal) throw opened.refusal;
    const { generation, version, token } = opened;
    const instance = { instanceId, generation };
    let handle;
    try {
      if (version.manifest.data.scope === 'app') {
        leases.assertOwned(lease);
        ensureDataDirectory(context.dataOf(appId));
      }
      handle = await runner.start({ appId, instanceId, generation, mode, manifest: version.manifest,
        packageDirectory: context.packageOf(appId, version.version), dataDirectory: context.dataOf(appId),
        environment: { FULI_APP_ID: appId, FULI_APP_INSTANCE: instanceId, FULI_APP_TOKEN: token },
        onExit: (exit) => exited(appId, instance, exit) });
    } catch (error) {
      unlessClosed(() => endInstance(appId, lease, instance, 'start_failed', { sealedAt: now() }));
      throw error;
    }
    held.set(handle, { appId, instanceId, generation });
    // A start that returns after close began is stopped, never registered.
    if (closing) {
      await stopHandle(handle);
      unlessClosed(() => endInstance(appId, lease, instance, 'host_closing', { sealedAt: now() }));
      throw hostClosing();
    }
    let recorded;
    try {
      recorded = store.transaction(() => {
        leases.assertOwned(lease);
        return store.updateInstance(instance, { pid: handle.pid ?? null, pidIdentity: handle.pidIdentity ?? null,
          exePath: handle.exePath ?? null, socket: handle.socket ?? null });
      });
    } catch (error) {
      await stopHandle(handle);
      throw error;
    }
    if (!recorded) {
      await stopHandle(handle);
      throw superseded();
    }
    hosted.set(appId, { lease, ...instance, handle, sealing: null, sealed: false });
    return { status: 'running', appId, instanceId, generation, version: version.version, mode };
  }

  // Seals and stops this process's instance of the app. Resolves sealed, or
  // sealing when a write tool still holds the gate after the wait; the seal
  // then completes by itself when that tool ends. A stop that failed leaves
  // the instance hosted, sealed and holding its lease, and the next seal
  // tries the stop again.
  function seal(appId, reason) {
    const local = hosted.get(appId);
    if (!local) return Promise.resolve({ status: 'not_running' });
    local.sealing ??= sealHosted(appId, local, reason);
    return local.sealing;
  }

  function sealHosted(appId, local, reason) {
    const { lease } = local;
    if (!local.sealed) {
      store.transaction(() => {
        leases.assertOwned(lease);
        store.updateInstance(local, { state: 'stopping' });
        store.recordEvent({ appId, at: now(), action: 'stopping', detail: { instanceId: local.instanceId, reason } });
      });
    }
    const asked = context.clock().getTime();
    const entry = gates.enter(appId, { toolName: 'seal', since: now() });
    const done = entry.then((leave) => finishSeal(appId, local, reason, leave));
    // When the seal completes after the caller was told sealing, a failure
    // is recorded and left to the next seal or the next owner's reconcile.
    done.catch(() => {});
    local.done = done;
    const timeout = new AbortController();
    // The wait ends with the race either way, a failed stop included, so no timer outlives it.
    return Promise.race([done.then(() => 'sealed'), wait(SEAL_WAIT_MS, timeout.signal).then(() => 'waiting')])
      .finally(() => timeout.abort())
      .then((state) => {
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
  }

  // Holds the write gate until the process has stopped and its records are
  // final, so no start or write of this app runs between the seal and the end.
  async function finishSeal(appId, local, reason, leave) {
    try {
      if (!local.sealed) {
        store.transaction(() => {
          leases.assertOwned(local.lease);
          store.updateInstance(local, { state: 'sealed', sealedAt: now() });
          store.recordEvent({ appId, at: now(), action: 'sealed', detail: { instanceId: local.instanceId, reason } });
        });
        local.sealed = true;
      }
      try {
        await stopHandle(local.handle);
      } catch (error) {
        local.sealing = null;
        store.transaction(() => {
          if (leases.owns(local.lease)) {
            store.recordEvent({ appId, at: now(), action: 'stop_failed', detail: { instanceId: local.instanceId, reason } });
          }
        });
        throw error;
      }
      endInstance(appId, local.lease, local, reason);
      if (hosted.get(appId) === local) hosted.delete(appId);
      leases.release(local.lease);
    } finally {
      leave();
    }
  }

  // This instance's tokens end and it records its stop; it is sealed by now,
  // or never ran (a failed start). Another instance of the app is untouched.
  function endInstance(appId, lease, instance, reason, fields = {}) {
    store.transaction(() => {
      leases.assertOwned(lease);
      store.revokeInstanceTokens(appId, instance.instanceId, reason, now());
      store.updateInstance(instance, { ...fields, state: 'sealed', stoppedAt: now(), stopReason: reason });
      store.recordEvent({ appId, at: now(), action: 'stopped', detail: { instanceId: instance.instanceId, reason } });
    });
  }

  // Before a decision on the app, inside its lifecycle: this process's
  // instance is sealed and stopped first.
  async function end(appId, reason) {
    const sealed = await seal(appId, reason);
    if (sealed.status === 'sealing') throw sealingRefusal(sealed);
  }

  // An app process that ended by itself. Only the instance it was started
  // for, still hosted here and not already being sealed, is wrapped up.
  function exited(appId, { instanceId, generation }, { code = null, signal = null, category } = {}) {
    lifecycles.run(appId, { toolName: 'exit' }, async () => {
      const local = hosted.get(appId);
      const exitCategory = Object.hasOwn(EXIT_MESSAGES, category) ? category : 'crashed';
      if (closing || local?.instanceId !== instanceId || local.generation !== generation || local.sealing) return;
      store.transaction(() => {
        if (!leases.owns(local.lease)) return;
        store.recordEvent({ appId, at: now(), action: 'app_exited',
          detail: { instanceId, generation, code, signal, category: exitCategory, message: EXIT_MESSAGES[exitCategory] } });
      });
      await seal(appId, 'app_exited');
    }).catch(() => {});
  }

  // fuli app stop: this process's instance, or one whose host has exited
  // (taken over on exit evidence). force against a live host is refused.
  function stop({ appId, force = false }) {
    return admit(() => lifecycles.run(appId, { toolName: 'stop' }, async () => {
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
    }));
  }

  // Ends this process's part: admits nothing new, lets work in flight finish
  // (for CLOSE_WAIT_MS at most), seals and stops every instance it holds, then
  // stops every handle still held. A seal still waiting after CLOSE_WAIT_MS (a
  // write tool that never returns) has its process stopped all the same; its
  // records stay for the next owner's reconcile, as after a crash. Resolves
  // { complete, startsInFlight, notStopped }: complete only when nothing is in
  // flight and every process FULI started is confirmed stopped. Asked again,
  // it retries the stops that failed and keeps their handles meanwhile.
  async function close() {
    const first = !closing;
    closing = true;
    if (first) await settledWithin(Promise.allSettled([...inFlight]), closeWaitMs);
    await Promise.all([...hosted.entries()].map(async ([appId, local]) => {
      // A host whose lease another process took over records nothing more; its process still ends here.
      const owned = first && leases.owns(local.lease);
      if (owned) {
        local.sealing ??= sealHosted(appId, local, 'host_closing');
        local.sealing.catch(() => {});
      }
      if (!owned || !await settledWithin(local.done, closeWaitMs)) hosted.delete(appId);
    }));
    const notStopped = [];
    await Promise.all([...held.entries()].map(async ([handle, started]) => {
      try {
        await stopHandle(handle);
      } catch (error) {
        notStopped.push({ ...started, pid: handle.pid ?? null, code: error?.code ?? null });
      }
    }));
    for (const [appId, local] of hosted) if (!held.has(local.handle)) hosted.delete(appId);
    return { complete: inFlight.size === 0 && notStopped.length === 0, startsInFlight: inFlight.size, notStopped };
  }

  // Inside the app's write gate, holding its lease.
  async function reconcile(appId, lease) {
    const instance = store.instance(appId);
    // stopOrphan resolves only once the process is confirmed gone (or never
    // ran); a failure keeps the record and refuses the operation.
    if (unfinished(instance) && instance.ownerId !== lease.ownerId) {
      await runner.stopOrphan(instance);
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
    if (unfinished(instance)) throw liveInstance(instance);
  }

  return {
    start, stop, seal, end, reconcile, assertNoInstance, admit, close, verifyToken: tokens.verifyToken,
    hosted: (appId) => hosted.get(appId) ?? null,
    // Nothing hosted, held or in flight: closing has nothing to wait for.
    idle: () => hosted.size === 0 && held.size === 0 && inFlight.size === 0,
    assertOpen
  };
}

const hostClosing = () => appConflict('host_closing', 'This FULI process is shutting down; try again from a running FULI');

function liveInstance(instance) {
  if (instance.state === 'sealed') {
    return appConflict('instance_not_stopped', 'The app instance is sealed but its stop is not confirmed; '
      + 'run fuli app stop again', { instanceId: instance.instanceId });
  }
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
