import assert from 'node:assert/strict';
import test from 'node:test';

import { createSystemService, settingsFromActiveRuntime } from '../src/system/system-service.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const PATHS = Object.freeze({
  dataDir: '/data',
  graphRuntimeConfigPath: '/data/graph-runtime.json',
  graphRuntimeStatePath: '/data/graph-runtime-state.json',
  runtimeSettingsPath: '/data/runtime-settings.json',
  clientNodePath: '/runtime/node',
  mcpServerPath: '/package/src/mcp-server.js'
});

test('an independently connected loopback workspace is not a managed development port', () => {
  const active = settingsFromActiveRuntime({
    state: { runtimeSettings: DEFAULT_RUNTIME_SETTINGS, port: 2727 },
    graphConfig: { workspaces: [{ providerUrl: 'http://127.0.0.1:8789' }] },
  });
  assert.equal(active.ports.workspaceProvider, 8788);
});

test('client configuration exports the actual runtime path without reading credentials', () => {
  const service = createSystemService({
    paths: PATHS,
    runtimeConfigPath: '/custom runtime/settings.json',
    readJson: () => { throw new Error('must not read credentials'); },
    resourceMonitor: {}, runtimeBroker: {}, versionChecker: {}
  });
  const result = service.clientConnection();
  assert.equal(result.standard.mcpServers.fuli.args[2], '/custom runtime/settings.json');
  assert.deepEqual(result.standard.mcpServers.fuli, result.vscode.servers.fuli);
  assert.deepEqual(result.server, result.standard.mcpServers.fuli);
  assert.equal(result.server.env, undefined);
});

test('connection status delegates to its observer and never changes the export', () => {
  const service = createSystemService({ paths: PATHS, resourceMonitor: {}, runtimeBroker: {}, versionChecker: {},
    clientObserver: { observe: () => ({ scope: 'configuration', clients: [] }) } });
  assert.deepEqual(service.clientConnectionStatus(), { scope: 'configuration', clients: [] });
  assert.equal(service.clientConnection().server.command, PATHS.clientNodePath);
  assert.equal(service.clientConnection().server.args[0], PATHS.mcpServerPath);
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
    settingsApplier: { status: () => null, prepare: async () => ({ id: 'test-apply', status: 'applying' }) },
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
    versionChecker: { check: async () => ({ updateAvailable: true }) },
    update: { kind: () => 'windows-tray' }
  });

  const refreshOnly = await service.updateSettings({
    ...configured,
    resourceRefreshSeconds: 30
  });
  assert.equal(refreshOnly.restartRequired, false);

  const launcherOnly = await service.updateSettings({
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

  const changedPort = await service.updateSettings({
    ...configured,
    ports: { ...configured.ports, console: 3030 }
  });
  assert.equal(changedPort.active.ports.console, 2727);
  assert.equal(changedPort.configured.ports.console, 3030);
  assert.equal(changedPort.restartRequired, true);
  assert.equal(changedPort.apply.status, 'applying');
  assert.deepEqual(await service.versionStatus(), { updateAvailable: true, updateKind: 'windows-tray' });
});
