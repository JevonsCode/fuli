import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSetupOptions,
  parseUninstallOptions,
  parseUpdateOptions
} from '../src/setup/options.js';

test('setup options have simple defaults', () => {
  assert.deepEqual(parseSetupOptions([]), {
    dataDir: null,
    personalSpaceName: 'Personal',
    port: null,
    memoryProfile: null,
    runtimeMode: null,
    adaptiveMemory: null,
    yes: false,
    codexOnly: false,
    skipAgents: false,
    personalOnly: true,
    noStart: false
  });
});

test('setup only starts the development public Provider when explicitly requested', () => {
  assert.equal(parseSetupOptions(['--with-dev-public']).personalOnly, false);
  assert.throws(
    () => parseSetupOptions(['--personal-only', '--with-dev-public']),
    /cannot be combined/
  );
});

test('setup options parse explicit automation values', () => {
  assert.deepEqual(parseSetupOptions([
    '--data-dir', 'D:/Fuli Data',
    '--personal-space', 'Jevons',
    '--port', '5199',
    '--memory-profile', 'low',
    '--runtime-mode', 'native',
    '--adaptive-memory',
    '--yes',
    '--codex-only',
    '--skip-agents',
    '--personal-only',
    '--no-start'
  ]), {
    dataDir: 'D:/Fuli Data',
    personalSpaceName: 'Jevons',
    port: 5199,
    memoryProfile: 'low',
    runtimeMode: 'native',
    adaptiveMemory: true,
    yes: true,
    codexOnly: true,
    skipAgents: true,
    personalOnly: true,
    noStart: true
  });
});

test('setup options reject unknown, duplicate, missing, and invalid values', () => {
  assert.throws(() => parseSetupOptions(['--wat']), /Unknown setup option: --wat/);
  assert.throws(() => parseSetupOptions(['--yes', '--yes']), /Duplicate --yes/);
  assert.throws(() => parseSetupOptions(['--data-dir']), /Missing value for --data-dir/);
  assert.throws(() => parseSetupOptions(['--personal-space', '  ']),
    /Missing value for --personal-space/);
  assert.throws(() => parseSetupOptions(['--port', '0']), /--port must be between 1 and 65535/);
  assert.throws(() => parseSetupOptions(['--port', 'abc']), /--port must be between 1 and 65535/);
  assert.throws(
    () => parseSetupOptions(['--memory-profile', 'tiny']),
    /must be "low" or "balanced"/
  );
  assert.throws(
    () => parseSetupOptions(['--runtime-mode', 'virtual-machine']),
    /must be "container" or "native"/
  );
  assert.throws(
    () => parseSetupOptions(['--adaptive-memory', '--no-adaptive-memory']),
    /cannot be combined/
  );
});

test('update accepts setup options and reports update-specific option errors', () => {
  assert.deepEqual(
    parseUpdateOptions(['--yes', '--data-dir', 'D:/Fuli', '--no-start']),
    {
      dataDir: 'D:/Fuli',
      personalSpaceName: 'Personal',
      port: null,
      memoryProfile: null,
      runtimeMode: null,
      adaptiveMemory: null,
      yes: true,
      codexOnly: false,
      skipAgents: false,
      personalOnly: true,
      noStart: true
    }
  );
  assert.throws(() => parseUpdateOptions(['--wat']), /Unknown update option: --wat/);
});

test('uninstall options are intentionally limited to confirmation and data location', () => {
  assert.deepEqual(parseUninstallOptions([]), { dataDir: null, yes: false });
  assert.deepEqual(parseUninstallOptions(['--yes', '--data-dir', 'D:/Fuli Data']), {
    dataDir: 'D:/Fuli Data',
    yes: true
  });
  assert.throws(() => parseUninstallOptions(['--delete-data']), /Unknown uninstall option/);
  assert.throws(() => parseUninstallOptions(['--data-dir']), /Missing value/);
});
