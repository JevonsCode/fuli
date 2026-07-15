import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSetupOptions } from '../src/setup/options.js';

test('setup options have simple defaults', () => {
  assert.deepEqual(parseSetupOptions([]), {
    dataDir: null,
    personalSpaceName: '我',
    port: 5173,
    yes: false,
    skipAgents: false,
    noStart: false
  });
});

test('setup options parse explicit automation values', () => {
  assert.deepEqual(parseSetupOptions([
    '--data-dir', 'D:/Fuli Data',
    '--personal-space', 'Jevons',
    '--port', '5199',
    '--yes',
    '--skip-agents',
    '--no-start'
  ]), {
    dataDir: 'D:/Fuli Data',
    personalSpaceName: 'Jevons',
    port: 5199,
    yes: true,
    skipAgents: true,
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
});
