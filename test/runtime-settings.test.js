import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERSATION_LAUNCHER_APPLICATIONS,
  DEFAULT_CONVERSATION_LAUNCHERS,
  DEFAULT_RUNTIME_SETTINGS,
  managedProviderUrls,
  normalizeRuntimeSettings,
  runtimeSettingsWithOverrides,
  writeRuntimeSettings
} from '../src/system/runtime-settings.js';

test('runtime settings validate unique ports and browser-safe console ports', () => {
  assert.equal(DEFAULT_RUNTIME_SETTINGS.ports.personalNeo4jHttp, 8060);
  assert.equal(DEFAULT_RUNTIME_SETTINGS.graphRuntimeMode, 'container');
  assert.deepEqual(Object.keys(DEFAULT_CONVERSATION_LAUNCHERS).sort(), [
    ...CONVERSATION_LAUNCHER_APPLICATIONS
  ].sort());
  assert.deepEqual(DEFAULT_CONVERSATION_LAUNCHERS.claude, {
    enabled: false,
    idFormat: 'any',
    appName: 'Claude',
    urlTemplate: ''
  });
  const custom = runtimeSettingsWithOverrides(DEFAULT_RUNTIME_SETTINGS, {
    consolePort: 3030,
    lanAccess: true
  });
  assert.equal(custom.ports.console, 3030);
  assert.equal(custom.lanAccess, true);
  assert.deepEqual(custom.conversationLaunchers.codex, {
    enabled: true,
    idFormat: 'uuid',
    appName: 'Codex',
    urlTemplate: 'codex://threads/{id}'
  });
  assert.deepEqual(managedProviderUrls(custom), {
    personal: 'http://127.0.0.1:8787',
    workspace: 'http://127.0.0.1:8788'
  });
  assert.equal(normalizeRuntimeSettings({
    ...custom,
    graphRuntimeMode: 'native'
  }).graphRuntimeMode, 'native');
  assert.throws(
    () => normalizeRuntimeSettings({ ...custom, graphRuntimeMode: 'virtual-machine' }),
    /graphRuntimeMode must be container or native/
  );
  assert.throws(
    () => normalizeRuntimeSettings({
      ...custom,
      ports: { ...custom.ports, personalProvider: 3030 }
    }),
    /different port/
  );
  assert.throws(
    () => runtimeSettingsWithOverrides(custom, { consolePort: 6000 }),
    /blocked/
  );
  assert.throws(
    () => normalizeRuntimeSettings({
      ...custom,
      ports: { ...custom.ports, console: '3030' }
    }),
    /integer/
  );
  assert.throws(
    () => normalizeRuntimeSettings({
      ...custom,
      ports: { ...custom.ports, console: true }
    }),
    /integer/
  );
  const cursorLauncher = normalizeRuntimeSettings({
    ...custom,
    conversationLaunchers: {
      ...structuredClone(DEFAULT_CONVERSATION_LAUNCHERS),
      cursor: {
        enabled: true,
        idFormat: 'uuid',
        appName: 'Cursor',
        urlTemplate: 'cursor://conversation/{id}'
      }
    }
  });
  assert.deepEqual(cursorLauncher.conversationLaunchers.cursor, {
    enabled: true,
    idFormat: 'uuid',
    appName: 'Cursor',
    urlTemplate: 'cursor://conversation/{id}'
  });
  assert.throws(
    () => normalizeRuntimeSettings({
      ...custom,
      conversationLaunchers: {
        ...structuredClone(DEFAULT_CONVERSATION_LAUNCHERS),
        codex: {
          enabled: true,
          idFormat: 'any',
          appName: 'Browser',
          urlTemplate: 'javascript:alert({id})'
        }
      }
    }),
    /safe URL scheme/
  );
});

test('runtime settings writes one validated secure payload', () => {
  const calls = [];
  const result = writeRuntimeSettings('/data/runtime-settings.json', DEFAULT_RUNTIME_SETTINGS, {
    write: (path, value) => calls.push(['write', path, value]),
    secure: (path) => calls.push(['secure', path])
  });
  assert.deepEqual(result, DEFAULT_RUNTIME_SETTINGS);
  assert.deepEqual(calls.map(([name]) => name), ['write', 'secure']);
});

test('runtime settings fills legacy launcher keys and round-trips the normalized payload', () => {
  const legacy = {
    ...DEFAULT_RUNTIME_SETTINGS,
    conversationLaunchers: {
      codex: {
        ...DEFAULT_CONVERSATION_LAUNCHERS.codex,
        enabled: false
      }
    }
  };
  const calls = [];
  const saved = writeRuntimeSettings('/data/runtime-settings.json', legacy, {
    write: (path, value) => calls.push(['write', path, value]),
    secure: () => {}
  });

  assert.deepEqual(saved.conversationLaunchers.codex, {
    ...DEFAULT_CONVERSATION_LAUNCHERS.codex,
    enabled: false
  });
  assert.deepEqual(saved.conversationLaunchers.claude, DEFAULT_CONVERSATION_LAUNCHERS.claude);
  assert.deepEqual(normalizeRuntimeSettings(calls[0][2]), saved);
});
