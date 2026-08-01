import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RUNTIME_SETTINGS,
  managedProviderUrls,
  normalizeRuntimeSettings,
  runtimeSettingsWithOverrides,
  writeRuntimeSettings
} from '../src/system/runtime-settings.js';

test('runtime settings validate unique ports and browser-safe console ports', () => {
  assert.equal(DEFAULT_RUNTIME_SETTINGS.ports.personalNeo4jHttp, 8060);
  const custom = runtimeSettingsWithOverrides(DEFAULT_RUNTIME_SETTINGS, {
    consolePort: 3030,
    lanAccess: true
  });
  assert.equal(custom.ports.console, 3030);
  assert.equal(custom.lanAccess, true);
  assert.deepEqual(managedProviderUrls(custom), {
    personal: 'http://127.0.0.1:8787',
    workspace: 'http://127.0.0.1:8788'
  });
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
