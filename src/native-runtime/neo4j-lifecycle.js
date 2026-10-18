import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { managedGraphInstances } from '../backup/runtime-adapters.js';
import { localRuntimeControl } from '../cli/local-runtime-control.js';
import { isProcessAlive } from '../local-runtime/processes.js';
import { readJsonFile, writeJsonFileAtomic, writeTextFileAtomic } from '../storage/json-file.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';
import { assertManagedNeo4jHome, neo4jAssetFingerprint, acquireNeo4jLifecycleLock, assetContainer, managedNeo4jContainers } from './neo4j-asset-state.js';
import { assertMacNativePortFree } from './macos-ports.js';
import { installNativeNeo4j } from './neo4j-install.js';
import { readNeo4jStoreFormats } from './neo4j-store-formats.js';
import { createNativeGraphServices, requireReusableNativeRuntime, NATIVE_NEO4J_VERSION, NATIVE_NEO4J_URL, NATIVE_NEO4J_SHA256 } from './runtime.js';

export async function planNativeNeo4j({ paths, action }) {
  if (!['update', 'rollback', 'uninstall'].includes(action)) throw new Error('Native runtime action must be update, rollback or uninstall.');
  if (existsSync(join(paths.nativeRuntimeDir, 'neo4j-transaction.json'))) throw new Error('A Neo4j transaction needs recovery before another operation.');
  const bytes = await readFile(paths.nativeRuntimeManifestPath);
  const current = JSON.parse(bytes);
  if (current.status !== 'ready' || current.mode !== 'native') throw new Error('Initialize the native runtime with fuli setup --runtime-mode native first.');
  if (current.neo4jVersion !== NATIVE_NEO4J_VERSION) throw new Error('Neo4j version changes require a separate data migration. Implicit upgrades and downgrades are blocked.');
  await assertManagedNeo4jHome(paths, current.neo4jHome, current.neo4jVersion);
  const fingerprint = await neo4jAssetFingerprint(current.neo4jHome);
  if (current.neo4jAssetFingerprint && current.neo4jAssetFingerprint !== fingerprint) throw new Error('Current Neo4j asset integrity changed.');
  if (action === 'rollback') {
    const previous = current.previousNeo4jAsset;
    if (!previous || previous.version !== current.neo4jVersion) throw new Error('No retained same-version Neo4j assets are available for rollback.');
    await assertManagedNeo4jHome(paths, previous.home, previous.version);
    if (await neo4jAssetFingerprint(previous.home) !== previous.fingerprint) throw new Error('Retained Neo4j asset integrity changed.');
  }
  return { action, neo4jVersion: current.neo4jVersion, currentHome: current.neo4jHome,
    previousHome: current.previousNeo4jAsset?.home ?? null, data: 'preserved', bytes, current, fingerprint };
}

export async function manageNativeNeo4j({ paths, action, env = process.env }, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('This native Neo4j lifecycle command currently requires macOS.');
  const lock = await acquireNeo4jLifecycleLock(paths.nativeRuntimeDir);
  const journal = join(paths.nativeRuntimeDir, 'neo4j-transaction.json');
  const operationEnv = { ...env, FULI_NATIVE_ASSET_OPERATION: lock.token };
  const runtime = dependencies.runtime ?? localRuntimeControl(paths, operationEnv, () => {});
  const service = descriptor => (dependencies.services ?? ((selected, options) => createNativeGraphServices({ paths, runtimeDescriptor: selected, ...options })))(descriptor, { env: operationEnv });
  const stopped = dependencies.assertStopped ?? (state => assertStopped(paths, state));
  const formats = dependencies.storeFormats ?? (descriptor => readNeo4jStoreFormats(paths, descriptor));
  let candidateRoot;
  try {
    const plan = await planNativeNeo4j({ paths, action });
    const { current } = plan;
    const wasRunning = await runtime.consoleRunning();
    const oldState = readJsonFile(paths.nativeProcessStatePath, {});
    const wasDatabaseRunning = Object.keys(oldState.databases ?? {}).length > 0;
    const wasProviderRunning = Object.keys(oldState.providers ?? {}).length > 0;
    if (wasRunning) await (dependencies.checkRuntime ?? (() => requireReusableNativeRuntime({ paths, env: operationEnv })))();
    let target = current;
    if (action === 'update') {
      candidateRoot = join(paths.nativeRuntimeDir, 'neo4j-assets', `jvs-a-${randomUUID()}`);
      const home = join(candidateRoot, `neo4j-community-${NATIVE_NEO4J_VERSION}`);
      await assertManagedNeo4jHome(paths, home, NATIVE_NEO4J_VERSION);
      await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
      writeJsonFileAtomic(join(candidateRoot, 'fuli-asset-owner.json'), { kind: 'fuli-neo4j-assets', id: candidateRoot.split('/').at(-1), version: NATIVE_NEO4J_VERSION });
      await (dependencies.install ?? installNativeNeo4j)({ paths: { ...paths, nativeRuntimeDir: candidateRoot }, home,
        url: NATIVE_NEO4J_URL, sha256: NATIVE_NEO4J_SHA256 });
      await assertManagedNeo4jHome(paths, home, NATIVE_NEO4J_VERSION);
      target = { ...current, neo4jHome: home, neo4jAssetFingerprint: await neo4jAssetFingerprint(home) };
    } else if (action === 'rollback') {
      target = { ...current, neo4jHome: current.previousNeo4jAsset.home,
        neo4jAssetFingerprint: current.previousNeo4jAsset.fingerprint };
    }
    await lock.assertHeld(); await unchanged(paths.nativeRuntimeManifestPath, plan.bytes);
    const stopResult = await runtime.stop({ env: operationEnv });
    if (stopResult?.status !== 'stopped') throw new Error('Could not confirm the old runtime stopped; no assets were switched.');
    await stopped(oldState);
    let before;
    try { before = await formats(current); }
    catch (error) {
      await lock.assertHeld(); await unchanged(paths.nativeRuntimeManifestPath, plan.bytes);
      if (wasRunning) await runtime.start({ env: operationEnv });
      else if (wasDatabaseRunning) await service(current).start({ providers: wasProviderRunning });
      throw error;
    }
    if (action === 'rollback' && JSON.stringify(before) !== JSON.stringify(current.previousNeo4jAsset.storeFormats)) {
      if (wasRunning) await runtime.start({ env: operationEnv });
      else if (wasDatabaseRunning) await service(current).start({ providers: wasProviderRunning });
      throw new Error('Neo4j storage format changed. User rollback is blocked; no data was overwritten.');
    }
    await lock.assertHeld(); await unchanged(paths.nativeRuntimeManifestPath, plan.bytes);
    if (await neo4jAssetFingerprint(current.neo4jHome) !== plan.fingerprint) throw new Error('Current Neo4j assets changed while stopping.');
    if (action === 'uninstall') {
      const homes = [current.neo4jHome, current.previousNeo4jAsset?.home].filter(Boolean);
      const containers = new Set([await assertManagedNeo4jHome(paths, paths.nativeNeo4jHome, current.neo4jVersion),
        ...await managedNeo4jContainers(paths, current.neo4jVersion), ...homes.map(home => assetContainer(paths, home))]);
      for (const home of homes) await assertManagedNeo4jHome(paths, home, current.neo4jVersion);
      writeJsonFileAtomic(journal, { action, phase: 'removing-assets', previous: current });
      writeJsonFileAtomic(paths.nativeRuntimeManifestPath, { ...current, status: 'uninstalled' });
      const uninstalled = await readFile(paths.nativeRuntimeManifestPath);
      for (const container of containers) { await lock.assertHeld(); await unchanged(paths.nativeRuntimeManifestPath, uninstalled); await rm(container, { recursive: true, force: true }); }
      await rm(journal);
      return { status: 'uninstalled', data: 'preserved' };
    }
    target.previousNeo4jAsset = { home: current.neo4jHome, version: current.neo4jVersion,
      fingerprint: plan.fingerprint, storeFormats: before };
    const nextBytes = Buffer.from(`${JSON.stringify(target, null, 2)}\n`);
    const targetServices = service(target);
    writeJsonFileAtomic(journal, { action, phase: 'switching', previous: current, next: target, storeFormats: before });
    let switched = false, consoleStartAttempted = false;
    try {
      await lock.assertHeld(); await unchanged(paths.nativeRuntimeManifestPath, plan.bytes);
      writeTextFileAtomic(paths.nativeRuntimeManifestPath, nextBytes); switched = true;
      await targetServices.start({ providers: false });
      for (const instance of managedGraphInstances(paths)) await targetServices.checkDatabaseHealth(instance);
      await targetServices.stopDatabases(); await stopped();
      if (JSON.stringify(await formats(target)) !== JSON.stringify(before)) throw new Error('Neo4j storage format changed after the switch.');
      await lock.assertHeld(); await unchanged(paths.nativeRuntimeManifestPath, nextBytes);
      if (wasRunning) { consoleStartAttempted = true; await runtime.start({ env: operationEnv }); }
      else if (wasDatabaseRunning) await targetServices.start({ providers: wasProviderRunning });
      await unchanged(paths.nativeRuntimeManifestPath, nextBytes);
      await rm(journal);
      return { status: action === 'rollback' ? 'rolled_back' : 'updated', neo4jHome: target.neo4jHome, data: 'preserved' };
    } catch (error) {
      await lock.assertHeld();
      if (switched) await unchanged(paths.nativeRuntimeManifestPath, nextBytes);
      try {
        if (consoleStartAttempted && (await runtime.stop({ env: operationEnv }))?.status !== 'stopped') throw new Error('Candidate console could not be stopped.');
        await targetServices.stopDatabases(); await stopped();
        if (JSON.stringify(await formats(target)) !== JSON.stringify(before)) throw new Error('Neo4j storage format changed; unsafe rollback blocked.');
      } catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Neo4j rollback needs attention. The candidate was not replaced and recovery evidence was kept.'); }
      if (await neo4jAssetFingerprint(current.neo4jHome) !== plan.fingerprint) throw new Error('Previous assets changed; recovery needs attention.');
      if (switched) writeTextFileAtomic(paths.nativeRuntimeManifestPath, plan.bytes);
      const old = service(current);
      await old.start({ providers: wasProviderRunning });
      for (const instance of managedGraphInstances(paths)) await old.checkDatabaseHealth(instance);
      if (wasRunning) await runtime.start({ env: operationEnv });
      else if (!wasDatabaseRunning) await old.stopDatabases();
      await rm(journal);
      throw new Error('Neo4j switch failed; the previous assets were restored. Data was preserved.', { cause: error });
    }
  } finally { await lock.release(); }
}
async function unchanged(path, bytes) {
  if (!(await readFile(path)).equals(bytes)) throw new Error('Native Neo4j descriptor changed concurrently; it was left untouched.');
}
async function assertStopped(paths, state = readJsonFile(paths.nativeProcessStatePath, {})) {
  for (const entry of [...Object.values(state.databases ?? {}), ...Object.values(state.providers ?? {})]) {
    if (Number.isInteger(entry.pid) && isProcessAlive(entry.pid)) throw new Error('A previously recorded native process is still alive; assets were not changed.');
  }
  const { ports } = readRuntimeSettings(paths.runtimeSettingsPath);
  for (const instance of managedGraphInstances(paths)) {
    const prefix = instance === 'personal' ? 'personal' : 'workspace';
    for (const suffix of ['Neo4jHttp', 'Neo4jBolt', 'Provider']) await assertMacNativePortFree(ports[`${prefix}${suffix}`]);
  }
}
