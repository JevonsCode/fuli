import * as realFs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentAppContext, agentAppServiceOver } from '../src/agent-apps/service.js';
import { createConfirmedDecisions } from '../src/agent-apps/confirmed-decisions.js';

// Synthetic FULI host processes for Agent app runner tests (rec#7 PR②). Each
// host is one context over the same registry, as a console, a standalone
// runner and a CLI would open it. Nothing real is probed, started or
// stopped: process liveness comes from `world`, which the test sets, and
// instances run in a fake runner that starts nothing.

export const CLI_USER = Object.freeze({ entrypoint: 'cli', user: 'fixture-user' });
export const CONSOLE_USER = Object.freeze({ entrypoint: 'http', user: 'local-console' });

export const MANIFEST = Object.freeze({
  schemaVersion: 1, name: 'dispatch-log', version: '1.0.0', title: 'Dispatch log',
  description: 'Synthetic fixture service that keeps dispatched replies.',
  permissions: [],
  runtime: { apiVersion: 1, entry: 'service/main.js' },
  data: { scope: 'app', format: 1 }
});
export const FILES = Object.freeze([{ path: 'service/main.js', content: 'export const synthetic = true;\n' }]);

// A latch a fake tool or file system waits on until the test opens it.
export function latch() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

// Lets pending promise reactions and fs callbacks run.
export const settle = () => new Promise((resolve) => setImmediate(resolve));

// Polls by time, not by turns, so a busy test runner's slower file I/O does not time it out.
const UNTIL_MS = 10_000;

export async function until(condition, label = 'condition') {
  const deadline = Date.now() + UNTIL_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// verdicts: pid → 'alive' | 'exited' | 'unknown'; a pid not listed is alive.
// onProbe(pid) runs while a probe is in flight.
export function fakeWorld() {
  return { verdicts: new Map(), probes: [], onProbe: null };
}

function fakeHostIdentity(world, pid) {
  return {
    platform: 'test',
    self: async () => ({ pid, identity: `test:${pid}`, exePath: '/synthetic/node' }),
    probe: async ({ pid: probed, identity }) => {
      world.probes.push(probed);
      if (world.onProbe) await world.onProbe(probed);
      return identity === `test:${probed}` ? world.verdicts.get(probed) ?? 'alive' : 'unknown';
    }
  };
}

// A runner that starts nothing and records what it was asked. hooks.<step>,
// when set, runs (and may wait or throw) before selfCheck, start or stop answer.
export function fakeRunner({ selfCheck = { ok: true } } = {}) {
  const calls = [];
  const started = [];
  const hooks = {};
  let next = 7000;
  return {
    kind: 'fake', calls, started, hooks,
    selfCheck: async () => { await hooks.selfCheck?.(); return selfCheck; },
    start: async (spec) => {
      await hooks.start?.();
      calls.push(['start', spec.instanceId]);
      started.push(spec);
      next += 1;
      return { pid: next, pidIdentity: `fake:${next}`, exePath: '/synthetic/app', socket: `fake-socket-${spec.instanceId}` };
    },
    stop: async (handle) => {
      await hooks.stop?.();
      calls.push(['stop', handle.pid]);
    },
    stopOrphan: async (instance) => {
      await hooks.stopOrphan?.();
      calls.push(['stopOrphan', instance.instanceId]);
      return { stopped: true };
    }
  };
}

// A file system that counts every call and can hold writeFile at a latch.
export function countingFs() {
  const calls = [];
  const holds = [];
  const counted = (name) => async (...args) => {
    calls.push([name, String(args[0])]);
    if (name === 'writeFile' && holds.length) await holds.shift().promise;
    return realFs[name](...args);
  };
  return {
    calls, holds,
    fs: Object.fromEntries(['lstat', 'readFile', 'writeFile', 'readdir', 'mkdir', 'rm'].map((name) => [name, counted(name)]))
  };
}

// wait(ms) resolves when the test calls elapse(); abort ends it early.
export function fakeWait() {
  const waiting = [];
  const wait = (ms, signal) => new Promise((resolve) => {
    waiting.push(resolve);
    signal?.addEventListener('abort', resolve, { once: true });
  });
  return { wait, elapse: () => { for (const resolve of waiting.splice(0)) resolve(); }, waiting: () => waiting.length };
}

// One registry directory and a clock shared by every host opened on it.
export function appRegistry(t, { tools = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-app-hosts-'));
  const root = join(directory, 'agent-apps');
  const clock = { now: Date.parse('2026-10-24T08:00:00.000Z') };
  const world = fakeWorld();
  const opened = [];
  // A host closes as a FULI process does: its instances are sealed and stopped first.
  t.after(async () => {
    await Promise.all(opened.map((service) => service.close()));
    rmSync(directory, { recursive: true, force: true });
  });

  function host({ pid, ownerKind = 'console', runner = fakeRunner(), hostTools = new Map(), fs = realFs,
    wait, timers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} } } = {}) {
    const context = agentAppContext({ root, providerIdentity: 'http://127.0.0.1:65530', ownerKind,
      resolveOwner: async (owner) => owner, toolNames: () => tools, clock: () => new Date(clock.now),
      hostIdentity: fakeHostIdentity(world, pid), runner, hostTools: () => hostTools, fs, wait,
      timers });
    const service = agentAppServiceOver(context);
    opened.push(service);
    // The terminal confirmation answers with the app's name, as a user typing it would.
    const decisions = createConfirmedDecisions(context, { confirmation: { ask: async ({ appName }) => appName } });
    return { context, service, decisions, runner, pid };
  }

  return { directory, root, clock, world, host, dataOf: (appId) => join(root, 'data', appId) };
}

// An active version approved through a (fake) terminal confirmation, which the run gate accepts.
export async function verifiedApp(host, manifest = {}, files = FILES) {
  const submitted = await host.service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs',
    manifest: { ...MANIFEST, ...manifest }, files });
  await host.decisions.approve({ appId: submitted.appId, version: submitted.version, digest: submitted.digest, approver: CLI_USER });
  return submitted;
}

export function events(host, appId) {
  return host.context.store.events(appId, 1000).map(({ action }) => action);
}

export function ownerColumns(host, appId) {
  const { ownerId, fence, pid } = host.context.store.owner(appId);
  return { ownerId, fence, pid };
}
