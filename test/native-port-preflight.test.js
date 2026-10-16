import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';

import { createNativeGraphServices } from '../src/native-runtime/runtime.js';
import { assertWindowsNativePortFree } from '../src/native-runtime/windows-processes.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const PATHS = Object.freeze({
  graphEnvPath: '/data/graph-provider.env', graphRuntimeConfigPath: '/data/graph-runtime.json',
  graphRuntimeStatePath: '/data/graph-state.json', runtimeSettingsPath: '/data/runtime-settings.json',
  nativeRuntimeManifestPath: '/data/native-runtime/manifest.json', nativeProcessStatePath: '/data/native-runtime/processes.json',
  nativeNeo4jHome: '/data/native-runtime/neo4j-5.26.28', nativeProviderVenvPath: '/data/native-runtime/provider-venv',
  nativePersonalDir: '/data/native-runtime/personal', nativeWorkspaceDir: '/data/native-runtime/workspace'
});
const ENVIRONMENT = ['FULI_PERSONAL_NEO4J_PASSWORD=personal-password', 'FULI_WORKSPACE_NEO4J_PASSWORD=workspace-password',
  'FULI_PERSONAL_BOOTSTRAP_TOKEN=personal-bootstrap-token-1234', 'FULI_PERSONAL_HUMAN_REVIEW_TOKEN=personal-review-token-1234567890',
  'FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN=workflow-token-1234567890123456789012345',
  'FULI_WORKSPACE_BOOTSTRAP_TOKEN=workspace-bootstrap-token-12', 'FULI_NEO4J_HEAP_INITIAL_SIZE=128m',
  'FULI_NEO4J_HEAP_MAX_SIZE=256m', 'FULI_NEO4J_PAGECACHE_SIZE=64m'].join('\n');

function fixture({ busy = new Set(), state = null } = {}) {
  const events = [];
  let processState = state;
  const services = createNativeGraphServices({
    paths: PATHS, platform: 'linux', personalOnly: true,
    runtimeDescriptor: { status: 'ready', mode: 'native', javaHome: '/jdk-21', neo4jHome: PATHS.nativeNeo4jHome,
      providerPython: '/synthetic/python' },
    readText: () => ENVIRONMENT, writeText: async () => {}, pathExists: () => true,
    readSettings: () => ({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }),
    waitForDatabase: async () => {}, verifyPortOwner: async () => {},
    verifyPortFree: async port => {
      events.push(`free:${port}`);
      if (busy.has(port)) throw new Error(`port ${port} is already in use`);
    },
    processMatches: async pid => [4400, 4500, 4700, 4800].includes(pid),
    stopProcess: async pid => { events.push(`stop:${pid}`); },
    spawnDatabase: () => { events.push('spawn:database'); return { pid: 4700 }; },
    spawnProvider: () => { events.push('spawn:provider'); return { pid: 4800 }; },
    readProcessState: () => processState, writeProcessState: (_path, value) => { processState = value; },
    fetchImpl: async () => Response.json({ status: 'ready', transcript_contract: 1 }), wait: async () => {}
  });
  return { services, events };
}

const ports = DEFAULT_RUNTIME_SETTINGS.ports;

test('native start checks Bolt and HTTP before Neo4j and the Provider port before the Provider', async () => {
  const f = fixture();
  await f.services.start();
  assert.deepEqual(f.events, [`free:${ports.personalNeo4jBolt}`, `free:${ports.personalNeo4jHttp}`, 'spawn:database',
    `free:${ports.personalProvider}`, 'spawn:provider']);
});

test('a port held by another process fails before anything is spawned or stopped', async () => {
  for (const port of [ports.personalNeo4jBolt, ports.personalNeo4jHttp]) {
    const f = fixture({ busy: new Set([port]) });
    await assert.rejects(f.services.start(), /already in use/);
    assert.equal(f.events.some(event => event.startsWith('spawn:') || event.startsWith('stop:')), false, JSON.stringify(f.events));
  }
  const f = fixture({ busy: new Set([ports.personalProvider]) });
  await assert.rejects(f.services.start(), /already in use/);
  // Only the database this start created is reclaimed; no Provider was spawned.
  assert.deepEqual(f.events.filter(event => event.startsWith('spawn:') || event.startsWith('stop:')), ['spawn:database', 'stop:4700']);
});

test('reusing a verified running process does not require its port to be free', async () => {
  const f = fixture({ state: { version: 1, databases: { personal: { pid: 4400, command: PATHS.nativeNeo4jHome } },
    providers: { personal: { pid: 4500, command: '/synthetic/python' } } } });
  await f.services.start();
  assert.deepEqual(f.events, []);
});

test('Windows port preflight reports a real listener on any local address with its PID', {
  skip: process.platform !== 'win32', timeout: 60_000
}, async () => {
  for (const host of ['0.0.0.0', '127.0.0.1']) {
    const server = createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
    const { port } = server.address();
    try {
      await assert.rejects(assertWindowsNativePortFree(port), error => {
        assert.match(error.message, new RegExp(`already in use .*: ${port} \\(owner PIDs: ${process.pid} \\(node\\)\\)`));
        assert.match(error.message, /nothing was started or stopped/);
        return true;
      });
    } finally { await new Promise(resolve => server.close(resolve)); }
    await assertWindowsNativePortFree(port);
  }
  await assert.rejects(assertWindowsNativePortFree(0), /Invalid native service port/);
});
