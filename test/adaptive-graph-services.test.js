import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGraphServices,
  createManagedGraphServices
} from '../src/adaptive-runtime/graph-services.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const PATHS = Object.freeze({
  graphEnvPath: '/data/graph-provider.env',
  graphComposePath: '/package/compose.graphiti.yml',
  graphRuntimeConfigPath: '/data/graph-runtime.json',
  graphRuntimeStatePath: '/data/graph-state.json',
  runtimeSettingsPath: '/data/runtime-settings.json'
});

test('adaptive graph services select native lifecycle without inspecting containers', () => {
  const native = { start() {}, stopProviders() {}, stopDatabases() {}, ready() {} };
  let nativeInput = null;
  const selected = createGraphServices({
    paths: PATHS,
    readSettings: () => ({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }),
    createContainerServices() {
      throw new Error('Container services must not be created in native mode');
    },
    createNativeServices(input) {
      nativeInput = input;
      return native;
    }
  });

  assert.equal(selected, native);
  assert.equal(nativeInput.paths, PATHS);
});

test('managed graph services operate only the configured Compose services in shutdown order',
  async () => {
    const compose = [];
    const health = [];
    const runtime = { status: 'ready' };
    const services = createManagedGraphServices({
      paths: PATHS,
      readJson(path) {
        if (path === PATHS.graphRuntimeStatePath) {
          return { managedProviders: ['personal', 'development-workspace'] };
        }
        if (path === PATHS.graphRuntimeConfigPath) {
          return {
            personal: { providerUrl: 'http://127.0.0.1:8787' },
            workspaces: [{
              providerUrl: 'http://127.0.0.1:8788',
              managedDevelopment: true
            }]
          };
        }
        return null;
      },
      readSettings: () => DEFAULT_RUNTIME_SETTINGS,
      ensureRuntime: async () => runtime,
      runCompose: (args, selectedRuntime) => compose.push({ args, selectedRuntime }),
      fetchImpl: async (url) => { health.push(url); return { ok: true }; }
    });

    await services.start();
    await services.stopProviders();
    await services.stopDatabases();

    assert.deepEqual(health, [
      'http://127.0.0.1:8787/health',
      'http://127.0.0.1:8788/health'
    ]);
    assert.deepEqual(compose[0], {
      args: [
        'compose', '--env-file', PATHS.graphEnvPath, '-f', PATHS.graphComposePath,
        'up', '-d', '--no-build',
        'personal-neo4j', 'workspace-neo4j',
        'personal-provider', 'workspace-provider'
      ],
      selectedRuntime: runtime
    });
    assert.deepEqual(compose.slice(1).map(({ args }) => args.slice(5)), [
      ['stop', '-t', '20', 'personal-provider', 'workspace-provider'],
      ['stop', '-t', '20', 'personal-provider', 'workspace-provider'],
      ['stop', '-t', '20', 'personal-neo4j', 'workspace-neo4j']
    ]);
  });
