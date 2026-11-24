import { existsSync, rmSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';

import { createAdaptiveRuntimeBroker } from '../adaptive-runtime/runtime-broker.js';
import { readAdaptiveRuntimeSettings } from '../adaptive-runtime/settings.js';
import { unfinishedImportError } from '../backup/unfinished-import.js';
import { createNativeGraphServices } from '../native-runtime/runtime.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { holdPreparationLock, readLocalRuntime } from './follower-local-runtime.js';
import { LEFT_MARKER } from './runner-mode.js';
import { ownsLocalProjects, OWNED_PROJECT_MARKER } from './owned-project-routes.js';

// Every start and stop competes for the same cross-process lock as import and
// leave. A busy transition is retried by the broker or by the next caller.
export function createFollowerBroker({ paths, url, owns = ownsLocalProjects, read = readLocalRuntime,
  createServices = createNativeGraphServices, createBroker = createAdaptiveRuntimeBroker, hold = holdPreparationLock, onLeave = () => {} }) {
  let active = null;
  let starting = null;
  let closed = false;
  const marker = join(paths.dataDir, OWNED_PROJECT_MARKER);
  const left = join(paths.dataDir, LEFT_MARKER);
  const refresh = () => { void current().catch(() => {}); };

  async function open() {
    const prepared = read(paths.dataDir);
    if (prepared.state !== 'ready' && prepared.code !== 'graph_format_waits') throw new Error('This computer’s graph runtime is not ready.');
    const services = createServices({ paths, personalOnly: true });
    const locked = action => async () => {
      const release = hold(paths.dataDir, { waitMs: 0 });
      if (!release) throw new Error('This computer’s graph runtime is being prepared or synced.');
      try {
        if (!owns(paths.dataDir)) throw new Error('This computer no longer owns a project here.');
        return await action();
      } finally { release(); }
    };
    const guarded = { ready: services.ready, start: locked(() => {
      const unfinished = unfinishedImportError(paths, 'native');
      if (unfinished) throw unfinished;
      return services.start();
    }),
      stopProviders: locked(services.stopProviders), stopDatabases: locked(services.stopDatabases) };
    const settings = readAdaptiveRuntimeSettings(paths.adaptiveRuntimeSettingsPath);
    const broker = createBroker({ paths, settings, services: guarded });
    try {
      if (settings.enabled) await broker.withLease({ kind: 'graph', owner: 'follower-console' }, async () => {});
      else await guarded.start();
      const state = { version: 4, pid: process.pid, url, port: Number(new URL(url).port),
        managedProviders: ['personal'], startedAt: new Date().toISOString(), follower: true };
      writeJsonFileAtomic(paths.graphRuntimeStatePath, state);
      active = { broker, guarded };
      return broker;
    } catch (error) { await broker.close(); throw error; }
  }

  async function current() {
    if (closed) return null;
    if (!owns(paths.dataDir)) {
      if (active) {
        const { broker } = active;
        active = null;
        await broker.close();
        clearAddress();
        if (existsSync(left)) onLeave();
      }
      return null;
    }
    if (active) return active.broker;
    starting ??= open().finally(() => { starting = null; });
    return starting;
  }

  function clearAddress() {
    const saved = readJsonFile(paths.graphRuntimeStatePath, null);
    if (saved?.follower && saved.pid === process.pid) rmSync(paths.graphRuntimeStatePath, { force: true });
  }

  // The marker wakes an existing console after the first local project is made.
  // A preparation still running at that moment can finish on a later tick.
  watchFile(marker, { persistent: false, interval: 1000 }, refresh);
  watchFile(left, { persistent: false, interval: 1000 }, refresh);
  const timer = setInterval(refresh, 60_000);
  timer.unref();
  refresh();
  return { current, status: () => active?.broker.status?.() ?? null, async close() {
    closed = true;
    clearInterval(timer);
    unwatchFile(marker, refresh);
    unwatchFile(left, refresh);
    await starting?.catch(() => {});
    if (!active) return;
    await active.broker.close();
    try { if (owns(paths.dataDir)) await active.guarded.stopDatabases(); } finally { clearAddress(); }
  } };
}
