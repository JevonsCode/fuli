import assert from 'node:assert/strict';
import test from 'node:test';

import { createSystemService } from '../src/system/system-service.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const PATHS = Object.freeze({
  dataDir: '/data',
  graphRuntimeConfigPath: '/data/graph-runtime.json',
  graphRuntimeStatePath: '/data/graph-runtime-state.json',
  runtimeSettingsPath: '/data/runtime-settings.json'
});

test('system settings distinguish immediately applied refresh changes from restart changes', async () => {
  let configured = structuredClone(DEFAULT_RUNTIME_SETTINGS);
  const state = {
    version: 4,
    pid: 27,
    url: 'http://127.0.0.1:2727',
    port: 2727,
    runtimeSettings: structuredClone(DEFAULT_RUNTIME_SETTINGS)
  };
  const graphConfig = {
    personal: { providerUrl: 'http://127.0.0.1:8787' },
    workspaces: []
  };
  const service = createSystemService({
    paths: PATHS,
    packageRoot: '/package',
    activePort: 2727,
    activeLan: false,
    readJson(path, fallback) {
      if (path === PATHS.graphRuntimeStatePath) return state;
      if (path === PATHS.graphRuntimeConfigPath) return graphConfig;
      return fallback;
    },
    readSettings: () => configured,
    writeSettings(_path, value) {
      configured = structuredClone(value);
      return configured;
    },
    resourceMonitor: { sample: async () => ({ status: 'ready' }) },
    versionChecker: { check: async () => ({ updateAvailable: true }) }
  });

  const refreshOnly = service.updateSettings({
    ...configured,
    resourceRefreshSeconds: 30
  });
  assert.equal(refreshOnly.restartRequired, false);

  const launcherOnly = service.updateSettings({
    ...configured,
    conversationLaunchers: {
      ...configured.conversationLaunchers,
      cursor: {
        enabled: true,
        idFormat: 'any',
        appName: 'Cursor',
        urlTemplate: 'cursor://conversation/{id}'
      }
    }
  });
  assert.equal(launcherOnly.restartRequired, false);

  const changedPort = service.updateSettings({
    ...configured,
    ports: { ...configured.ports, console: 3030 }
  });
  assert.equal(changedPort.active.ports.console, 2727);
  assert.equal(changedPort.configured.ports.console, 3030);
  assert.equal(changedPort.restartRequired, true);
  assert.deepEqual(await service.versionStatus(), { updateAvailable: true });
});
