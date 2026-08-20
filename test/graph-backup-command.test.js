import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseGraphDataOptions,
  runGraphDataCommand
} from '../src/cli/graph-data-command.js';

test('graph data command parses explicit portable export and import targets', () => {
  assert.deepEqual(parseGraphDataOptions('export', [
    '--output', '/backups/fuli', '--mode', 'container', '--data-dir', '/data'
  ]), {
    action: 'export',
    outputDir: '/backups/fuli',
    inputDir: null,
    mode: 'container',
    dataDir: '/data',
    yes: false
  });
  assert.deepEqual(parseGraphDataOptions('import', [
    '--input', '/backups/fuli', '--target-mode', 'native', '--yes'
  ]), {
    action: 'import',
    outputDir: null,
    inputDir: '/backups/fuli',
    mode: 'native',
    dataDir: null,
    yes: true
  });
});

test('graph export uses the saved mode and all managed graph instances', async () => {
  let request = null;
  const output = [];
  const adapter = { instances: ['personal', 'workspace'] };
  await runGraphDataCommand('export', ['--output', '/portable'], {
    resolvePaths: () => ({
      runtimeSettingsPath: '/data/runtime-settings.json',
      graphRuntimeStatePath: '/data/state.json',
      graphRuntimeConfigPath: '/data/config.json'
    }),
    readSettings: () => ({ graphRuntimeMode: 'container' }),
    createAdapter: async () => adapter,
    exportData: async (input) => { request = input; return { status: 'exported' }; },
    write: (line) => output.push(line)
  });

  assert.equal(request.sourceMode, 'container');
  assert.deepEqual(request.instances, ['personal', 'workspace']);
  assert.equal(request.adapter, adapter);
  assert.match(output[0], /exported/i);
});

test('graph import requires confirmation before replacing target data', async () => {
  let imported = false;
  const result = await runGraphDataCommand('import', ['--input', '/portable'], {
    resolvePaths: () => ({
      dataDir: '/data',
      runtimeSettingsPath: '/data/runtime-settings.json',
      graphRuntimeStatePath: '/data/state.json',
      graphRuntimeConfigPath: '/data/config.json',
      graphBackupDir: '/data/backups/graph'
    }),
    readSettings: () => ({ graphRuntimeMode: 'native' }),
    confirm: async () => false,
    importData: async () => { imported = true; },
    write: () => {}
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(imported, false);
});
