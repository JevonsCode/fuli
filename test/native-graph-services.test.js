import assert from 'node:assert/strict';
import test from 'node:test';

import { createNativeGraphServices } from '../src/native-runtime/runtime.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

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
  'FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN=workflow-token-123456789012345',
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
      fetchImpl: async () => ({ ok: true })
    });

    await services.start();
    await services.stopProviders();
    await services.stopDatabases();

    assert.equal(configs.size, 2);
    assert.match(configs.get('/data/native-runtime/personal/conf/neo4j.conf'),
      /server\.bolt\.listen_address=127\.0\.0\.1:7687/);
    assert.match(configs.get('/data/native-runtime/workspace/conf/neo4j.conf'),
      /server\.bolt\.listen_address=127\.0\.0\.1:7688/);
    assert.deepEqual(commands.map(({ command, args }) => [command, ...args]), [
      ['/data/native-runtime/neo4j-5.26.28/bin/neo4j-admin',
        'dbms', 'set-initial-password', 'personal-password'],
      ['/data/native-runtime/neo4j-5.26.28/bin/neo4j-admin',
        'dbms', 'set-initial-password', 'workspace-password']
    ]);
    assert.deepEqual(spawnedDatabases.map(({ id, command, args }) => ({ id, command, args })), [
      {
        id: 'personal',
        command: '/data/native-runtime/neo4j-5.26.28/bin/neo4j',
        args: ['console']
      },
      {
        id: 'workspace',
        command: '/data/native-runtime/neo4j-5.26.28/bin/neo4j',
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
