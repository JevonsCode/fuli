import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createNativeGraphServices as createServices, ensureNativeRuntime } from '../src/native-runtime/runtime.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../src/storage/json-file.js';
import { spawnWindowsNativeProvider, stopWindowsNativeProcess, windowsNativeProcessMatches } from '../src/native-runtime/windows-processes.js';

const createNativeGraphServices = options => createServices({ platform: 'linux', ...options });

const PATHS = Object.freeze({
  graphEnvPath: '/data/graph-provider.env',
  graphRuntimeConfigPath: '/data/graph-runtime.json',
  graphRuntimeStatePath: '/data/graph-state.json',
  runtimeSettingsPath: '/data/runtime-settings.json',
  nativeRuntimeManifestPath: '/data/native-runtime/manifest.json',
  nativeProcessStatePath: '/data/native-runtime/processes.json',
  nativeNeo4jHome: '/data/native-runtime/neo4j-5.26.28',
  nativeProviderVenvPath: '/data/native-runtime/provider-venv',
  nativePersonalDir: '/data/native-runtime/personal',
  nativeWorkspaceDir: '/data/native-runtime/workspace'
});

const ENVIRONMENT = [
  'FULI_PERSONAL_NEO4J_PASSWORD=personal-password',
  'FULI_WORKSPACE_NEO4J_PASSWORD=workspace-password',
  'FULI_PERSONAL_BOOTSTRAP_TOKEN=personal-bootstrap-token-1234',
  'FULI_PERSONAL_HUMAN_REVIEW_TOKEN=personal-review-token-1234567890',
  'FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN=workflow-token-1234567890123456789012345',
  'FULI_WORKSPACE_BOOTSTRAP_TOKEN=workspace-bootstrap-token-12',
  'FULI_NEO4J_HEAP_INITIAL_SIZE=128m',
  'FULI_NEO4J_HEAP_MAX_SIZE=256m',
  'FULI_NEO4J_PAGECACHE_SIZE=64m'
].join('\n');

test('native graph services start databases before Providers and preserve shutdown order',
  async () => {
    const commands = [];
    const configs = new Map();
    const spawned = [];
    const spawnedDatabases = [];
    const stopped = [];
    let processState = null;
    let nextDatabasePid = 4000;
    let nextPid = 4100;
    const services = createNativeGraphServices({
      paths: PATHS,
      runtimeDescriptor: {
        status: 'ready',
        mode: 'native',
        javaHome: '/jdk-21',
        neo4jHome: PATHS.nativeNeo4jHome,
        providerPython: '/data/native-runtime/provider-venv/bin/python'
      },
      personalOnly: false,
      readText: () => ENVIRONMENT,
      writeText: (path, body) => configs.set(path, body),
      pathExists: () => false,
      markInitialized: () => {},
      readSettings: () => ({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }),
      run: async (command, args, options) => commands.push({ command, args, options }),
      waitForDatabase: async () => {},
      spawnDatabase(spec) {
        spawnedDatabases.push(spec);
        return { pid: nextDatabasePid++ };
      },
      spawnProvider(spec) {
        spawned.push(spec);
        return { pid: nextPid++ };
      },
      readProcessState: () => processState,
      writeProcessState: (_path, value) => { processState = value; },
      processMatches: async () => true,
      stopProcess: async (pid) => stopped.push(pid),
      fetchImpl: async () => Response.json({ status: 'ok', transcript_contract: 1 })
    });

    await services.start();
    await services.stopProviders();
    await services.stopDatabases();

    assert.equal(configs.size, 2);
    assert.match(configs.get(join(PATHS.nativePersonalDir, 'conf', 'neo4j.conf')),
      /server\.bolt\.listen_address=127\.0\.0\.1:7687/);
    assert.match(configs.get(join(PATHS.nativeWorkspaceDir, 'conf', 'neo4j.conf')),
      /server\.bolt\.listen_address=127\.0\.0\.1:7688/);
    assert.deepEqual(commands.map(({ command, args }) => [command, ...args]), [
      [join(PATHS.nativeNeo4jHome, 'bin', 'neo4j-admin'),
        'dbms', 'set-initial-password', 'personal-password'],
      [join(PATHS.nativeNeo4jHome, 'bin', 'neo4j-admin'),
        'dbms', 'set-initial-password', 'workspace-password']
    ]);
    assert.deepEqual(spawnedDatabases.map(({ id, command, args }) => ({ id, command, args })), [
      {
        id: 'personal',
        command: join(PATHS.nativeNeo4jHome, 'bin', 'neo4j'),
        args: ['console']
      },
      {
        id: 'workspace',
        command: join(PATHS.nativeNeo4jHome, 'bin', 'neo4j'),
        args: ['console']
      }
    ]);
    assert.deepEqual(spawned.map(({ id, port, environment }) => ({
      id,
      port,
      uri: environment.FULI_NEO4J_URI,
      mode: environment.FULI_PROVIDER_MODE
    })), [
      { id: 'personal', port: 8787, uri: 'bolt://127.0.0.1:7687', mode: 'personal' },
      { id: 'workspace', port: 8788, uri: 'bolt://127.0.0.1:7688', mode: 'workspace' }
    ]);
    assert.deepEqual(stopped, [4100, 4101, 4000, 4001]);
  });

test('native graph services do not signal a PID that no longer belongs to Fuli', async () => {
  let signalled = false;
  const services = createNativeGraphServices({
    paths: PATHS,
    runtimeDescriptor: {
      status: 'ready',
      mode: 'native',
      javaHome: '/jdk-21',
      neo4jHome: PATHS.nativeNeo4jHome,
      providerPython: '/data/native-runtime/provider-venv/bin/python'
    },
    personalOnly: true,
    readProcessState: () => ({
      version: 1,
      providers: { personal: { pid: 4100, command: '/expected/python' } }
    }),
    processMatches: async () => false,
    stopProcess: async () => { signalled = true; },
    writeProcessState: () => {}
  });

  await services.stopProviders();
  assert.equal(signalled, false);
});

function compatibilityFixture(health, options = {}) {
  const initial = { databases: { personal: { pid: 4400, command: PATHS.nativeNeo4jHome } },
    providers: { personal: { pid: 4500, command: '/synthetic/python' } } };
  let state = structuredClone(initial);
  const stopped = [], spawned = [], waits = [];
  const services = createNativeGraphServices({
    paths: PATHS, runtimeDescriptor: { status: 'ready', mode: 'native', javaHome: '/jdk-21',
      neo4jHome: PATHS.nativeNeo4jHome, providerPython: '/synthetic/python' }, personalOnly: true,
    readText: () => ENVIRONMENT, writeText: async () => {}, pathExists: () => true,
    readSettings: () => DEFAULT_RUNTIME_SETTINGS, waitForDatabase: async () => {},
    readProcessState: () => state, writeProcessState: (_path, value) => { state = value; },
    processMatches: async pid => !(options.staleProvider && pid === 4500), stopProcess: async pid => stopped.push(pid),
    spawnProvider: () => { spawned.push('provider'); return { pid: 4600 }; },
    spawnDatabase: () => { spawned.push('database'); return { pid: 4700 }; },
    fetchImpl: async () => Response.json(health), wait: async ms => waits.push(ms)
  });
  return { services, initial, stopped, spawned, waits, state: () => state };
}

test('native readiness rejects a healthy legacy Provider lacking the transcript contract', async () => {
  const f = compatibilityFixture({ status: 'ok' });
  assert.equal(await f.services.ready(), false);
});

test('incompatible reused Provider fails promptly without stopping other sessions or losing their PIDs', async () => {
  const f = compatibilityFixture({ status: 'ok' });
  await assert.rejects(f.services.start(), /incompatible|upgrade/i);
  assert.deepEqual(f.stopped, []);
  assert.deepEqual(f.spawned, []);
  assert.deepEqual(f.waits, [], 'A successful but incompatible health response is not retried for two minutes');
  assert.deepEqual(f.state().databases, f.initial.databases);
  assert.deepEqual(f.state().providers, f.initial.providers);
});

test('native readiness accepts the implemented transcript contract', async () => {
  const f = compatibilityFixture({ status: 'ok', transcript_contract: 1 });
  assert.equal(await f.services.ready(), true);
  await f.services.start();
  assert.deepEqual(f.spawned, []);
  assert.deepEqual(f.stopped, []);
});

test('startup failure cleans up only its new Provider while retaining the reused database', async () => {
  const f = compatibilityFixture({ status: 'ok' }, { staleProvider: true });
  await assert.rejects(f.services.start(), /incompatible/i);
  assert.deepEqual(f.spawned, ['provider']);
  assert.deepEqual(f.stopped, [4600]);
  assert.deepEqual(f.state().databases, f.initial.databases);
  assert.notEqual(f.state().providers.personal?.pid, 4600);
});

test('native graph services can resume databases without waking Providers', async () => {
  let databasePid = 4200;
  let providerSpawns = 0;
  let processState = null;
  const services = createNativeGraphServices({
    paths: PATHS,
    runtimeDescriptor: {
      status: 'ready',
      mode: 'native',
      javaHome: '/jdk-21',
      neo4jHome: PATHS.nativeNeo4jHome,
      providerPython: '/data/native-runtime/provider-venv/bin/python'
    },
    personalOnly: true,
    readText: () => ENVIRONMENT,
    writeText: async () => {},
    pathExists: () => true,
    readSettings: () => ({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }),
    waitForDatabase: async () => {},
    spawnDatabase: () => ({ pid: databasePid++ }),
    spawnProvider: () => { providerSpawns += 1; return { pid: 4300 }; },
    readProcessState: () => processState,
    writeProcessState: (_path, value) => { processState = value; },
    fetchImpl: async () => ({ ok: true })
  });

  await services.start({ providers: false });

  assert.equal(providerSpawns, 0);
  assert.deepEqual(Object.keys(processState.databases), ['personal']);
  assert.deepEqual(processState.providers, {});
});

test('provided Windows native assets persist knowledge across owned stop and restart', {
  skip: process.platform !== 'win32' || process.env.FULI_TEST_NATIVE_WINDOWS !== '1', timeout: 240_000
}, async t => {
  assert.ok(process.env.FULI_TEST_NATIVE_ASSETS && process.env.FULI_TEST_PYTHON,
    'Explicit read-only assets and development Python are required');
  const directory = mkdtempSync(join(tmpdir(), 'fuli native 便携 $ apostrophe\' '));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const paths = resolveSetupPaths({ dataDir: directory, packageRoot: process.cwd() });
  const sourceAssets = process.env.FULI_TEST_NATIVE_ASSETS;
  const assetRoots = ['neo4j', 'jre21'].map(name => join(sourceAssets, name));
  const beforeAssets = assetRoots.flatMap(assetSnapshot);
  const ports = await Promise.all([freeNativePort(), freeNativePort(), freeNativePort()]);
  assert.equal(new Set(ports).size, 3);
  const settings = { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native',
    ports: { ...DEFAULT_RUNTIME_SETTINGS.ports, personalNeo4jHttp: ports[0], personalNeo4jBolt: ports[1], personalProvider: ports[2] } };
  writeFileSync(paths.graphEnvPath, ENVIRONMENT);
  const descriptor = await ensureNativeRuntime({ paths, bundle: {
    neo4jHome: join(sourceAssets, 'neo4j'), javaHome: join(sourceAssets, 'jre21'),
    providerPython: process.env.FULI_TEST_PYTHON
  } });
  assert.equal(descriptor.neo4jVersion, '5.26.0');
  assert.equal(descriptor.javaVersion, '21.0.12.1');
  assert.equal(descriptor.providerPackaging, 'external', 'development venv is not portable product evidence');
  const options = { paths, platform: 'win32', runtimeDescriptor: descriptor,
    personalOnly: true, readSettings: () => settings,
    async spawnProvider(spec) {
      const entry = await spawnWindowsNativeProvider(spec);
      // Reproduce an early CIM snapshot that saw only the venv launcher.
      // Port readiness and rollback must rediscover the real owned child.
      return { ...entry, pid: entry.launcher.pid, command: entry.launcher.ownership.executable,
        ownership: entry.launcher.ownership, relatedProcesses: [] };
    } };
  const services = createServices(options);
  let foreign;
  t.after(async () => {
    try {
      await services.stopDatabases();
      assert.deepEqual(await Promise.all(ports.map(nativePortOpen)), [false, false, false]);
      assert.deepEqual(assetRoots.flatMap(assetSnapshot), beforeAssets, 'source asset SHA256 trees must remain unchanged');
      rmSync(directory, { recursive: true, force: true });
    } finally { foreign?.kill(); }
  });
  const state = () => readJsonFile(paths.nativeProcessStatePath);
  const allProcesses = snapshot => [snapshot.databases?.personal, snapshot.providers?.personal]
    .filter(Boolean).flatMap(entry => [entry, ...(entry.relatedProcesses ?? [])]);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await services.start();
    assert.equal(await services.ready(), true);
    assert.ok(existsSync(join(paths.nativePersonalDir, 'data', 'databases', 'neo4j')),
      'Unicode data must stay under the exact instance home, without escaped alternate directories');
    const initial = state();
    assert.ok(initial.databases.personal.ownership.commandLine.includes(paths.nativePersonalDir));
    assert.match(initial.databases.personal.command, /java\.exe$/i);
    await services.start();
    assert.deepEqual(state().databases, initial.databases, 'repeated start must reuse the actual Java process');
    assert.deepEqual(state().providers, initial.providers, 'repeated start must reuse the actual Python process');

    foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await once(foreign, 'spawn');
    const database = initial.databases.personal;
    assert.equal(await windowsNativeProcessMatches(foreign.pid, database.command, database), false);
    await stopWindowsNativeProcess(foreign.pid, database);
    assert.equal(alive(foreign.pid), true, 'forged PID must not stop another process');
    const reused = { ...database, ownership: { ...database.ownership,
      createdFileTime: String(BigInt(database.ownership.createdFileTime) - 10n) } };
    await stopWindowsNativeProcess(database.pid, reused);
    assert.equal(alive(database.pid), true, 'reused PID creation identity must fail closed');
    const wrongConfig = { ...database, ownership: { ...database.ownership,
      commandLine: database.ownership.commandLine + ' --config-dir=foreign' } };
    await stopWindowsNativeProcess(database.pid, wrongConfig);
    assert.equal(alive(database.pid), true, 'configuration identity must match before stop');

    await services.stopProviders();
    let failedProvider;
    const failure = createServices({ ...options,
      fetchImpl: async () => Response.json({ status: 'ok' }),
      writeProcessState(path, value) {
        if (value.providers.personal) failedProvider = value.providers.personal;
        writeJsonFileAtomic(path, value);
      } });
    await assert.rejects(failure.start(), /incompatible/);
    assert.ok(failedProvider);
    assert.ok(allProcesses({ providers: { personal: failedProvider } }).every(entry => !alive(entry.pid)),
      'failure must stop its real new Provider and launcher');
    assert.equal(alive(database.pid), true, 'failure must retain the reused database');
    await services.start();

    const baseUrl = 'http://127.0.0.1:' + ports[2];
    let token;
    const request = async (path, body, bootstrap = false) => {
      const response = await fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json',
        ...(bootstrap ? { 'x-fuli-bootstrap-token': 'personal-bootstrap-token-1234' } : { authorization: 'Bearer ' + token }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      assert.equal(response.ok, true, 'Synthetic native HTTP ' + response.status + ': ' + path);
      return response.json();
    };
    token = (await request('/v1/bootstrap', { principal_name: 'Synthetic native restart' }, true)).access_token;
    const space = await request('/v1/spaces', { name: 'Synthetic native restart', kind: 'personal' });
    const saved = await request('/v1/knowledge/commits', { space_id: space.id, episode: {
      idempotency_key: 'native-portable-synthetic-knowledge', session_id: 'synthetic-native-session',
      name: 'Synthetic native persistence', source_kind: 'synthetic_fixture',
      source_description: 'Synthetic native persistence evidence, not user knowledge.', reference_time: '2026-10-16T00:00:00Z',
      entities: [{ key: 'native-restart-fixture', name: 'NativeRestartFixture', type: 'SyntheticKnowledge',
        summary: 'NativeRestartFixture persisted before stop.', confirmation_status: 'pending' }]
    } });
    const stopped = state();
    await services.stopDatabases();
    assert.ok(allProcesses(stopped).every(entry => !alive(entry.pid)));
    assert.deepEqual(await Promise.all(ports.map(nativePortOpen)), [false, false, false]);
    assert.deepEqual(await ensureNativeRuntime({ paths }), descriptor, 'manifest must recover supplied assets without reinstalling');
    await services.start();
    assert.notEqual(state().databases.personal.ownership.createdFileTime, database.ownership.createdFileTime);
    const recalled = await request('/v1/search', { space_ids: [space.id], query: 'NativeRestartFixture',
      include_pending: true, include_personal_global: true, limit: 5 });
    assert.ok(JSON.stringify(recalled).includes(saved.entity_ids[0]), 'restart must read the same real graph entity');
  } catch (error) {
    t.diagnostic('Beijing discovery ' + new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
      + '; isolated native lifecycle; dataDir=' + directory);
    for (const name of ['neo4j-console.log', 'provider.log']) {
      try {
        let log = readFileSync(join(paths.nativePersonalDir, 'logs', name), 'utf8').slice(-2200);
        for (const line of ENVIRONMENT.split('\n').filter(value => /PASSWORD=|TOKEN=/.test(value))) {
          log = log.replaceAll(line.slice(line.indexOf('=') + 1), '[synthetic-secret-redacted]');
        }
        t.diagnostic(name + ': ' + log);
      }
      catch { /* no log before process creation */ }
    }
    throw error;
  }
});

async function freeNativePort() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

function nativePortOpen(port) {
  return new Promise(resolvePort => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = open => { socket.destroy(); resolvePort(open); };
    socket.setTimeout(250, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function assetSnapshot(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [[path, 'directory'], ...assetSnapshot(path)]
      : [[path, statSync(path).size, statSync(path).mtimeMs, createHash('sha256').update(readFileSync(path)).digest('hex')]];
  });
}
