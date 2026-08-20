import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
  adaptiveRuntimeSettingsWithOverrides,
  normalizeAdaptiveRuntimeSettings,
  writeAdaptiveRuntimeSettings
} from '../src/adaptive-runtime/settings.js';

test('adaptive runtime defaults favor low idle memory but remain opt-in', () => {
  assert.equal(DEFAULT_ADAPTIVE_RUNTIME_SETTINGS.enabled, false);
  assert.equal(DEFAULT_ADAPTIVE_RUNTIME_SETTINGS.providerIdleSeconds, 60);
  assert.equal(DEFAULT_ADAPTIVE_RUNTIME_SETTINGS.databaseIdleSeconds, 180);
  assert.equal(
    adaptiveRuntimeSettingsWithOverrides(DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, { enabled: true })
      .enabled,
    true
  );
});

test('adaptive runtime settings validate ordering, ranges, and secure persistence', () => {
  assert.throws(
    () => normalizeAdaptiveRuntimeSettings({
      ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
      providerIdleSeconds: 300,
      databaseIdleSeconds: 60
    }),
    /databaseIdleSeconds/
  );
  assert.throws(
    () => normalizeAdaptiveRuntimeSettings({
      ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
      leaseTtlSeconds: 2
    }),
    /leaseTtlSeconds/
  );

  const writes = [];
  const secured = [];
  const enabled = { ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true };
  const result = writeAdaptiveRuntimeSettings('/data/adaptive.json', enabled, {
    write: (path, value) => writes.push({ path, value }),
    secure: (path) => secured.push(path)
  });
  assert.deepEqual(result, enabled);
  assert.deepEqual(writes, [{ path: '/data/adaptive.json', value: enabled }]);
  assert.deepEqual(secured, ['/data/adaptive.json']);
});
