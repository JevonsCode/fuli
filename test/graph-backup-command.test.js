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

test('graph copy stops a running console first and starts it again even after a failure', async () => {
  const events = [];
  const runtime = {
    consoleRunning: async () => { events.push('inspect'); return true; },
    stop: async () => { events.push('stop'); return { status: 'stopped' }; },
    start: async () => { events.push('start'); return { status: 'running' }; }
  };
  const common = {
    resolvePaths: () => ({ runtimeSettingsPath: '/data/runtime-settings.json' }),
    readSettings: () => ({ graphRuntimeMode: 'native' }),
    runtime,
    write: () => {}
  };
  await runGraphDataCommand('export', ['--output', '/portable'], {
    ...common,
    createAdapter: async () => { events.push('adapter'); return { instances: ['personal'] }; },
    exportData: async () => { events.push('export'); return { status: 'exported' }; }
  });
  assert.deepEqual(events, ['inspect', 'stop', 'adapter', 'export', 'start']);

  events.length = 0;
  await assert.rejects(runGraphDataCommand('import', ['--input', '/portable', '--yes'], {
    ...common,
    createAdapter: async () => ({ instances: ['personal'] }),
    importData: async () => { events.push('import'); throw new Error('synthetic load failure'); }
  }), /synthetic load failure/);
  assert.deepEqual(events, ['inspect', 'stop', 'import', 'start']);
});

test('graph copy refuses to touch data when the running console cannot be confirmed stopped', async () => {
  let adapterCreated = false;
  let started = false;
  await assert.rejects(runGraphDataCommand('export', ['--output', '/portable'], {
    resolvePaths: () => ({ runtimeSettingsPath: '/data/runtime-settings.json' }),
    readSettings: () => ({ graphRuntimeMode: 'native' }),
    runtime: {
      consoleRunning: async () => true,
      stop: async () => ({ status: 'partial' }),
      start: async () => { started = true; }
    },
    createAdapter: async () => { adapterCreated = true; return { instances: [] }; },
    write: () => {}
  }), /Graph data was not changed/);
  assert.equal(adapterCreated, false);
  assert.equal(started, false);
});

test('graph copy leaves a stopped console stopped', async () => {
  const events = [];
  await runGraphDataCommand('export', ['--output', '/portable'], {
    resolvePaths: () => ({ runtimeSettingsPath: '/data/runtime-settings.json' }),
    readSettings: () => ({ graphRuntimeMode: 'container' }),
    runtime: {
      consoleRunning: async () => false,
      stop: async () => events.push('stop'),
      start: async () => events.push('start')
    },
    createAdapter: async () => ({ instances: ['personal'] }),
    exportData: async () => ({ status: 'exported' }),
    write: () => {}
  });
  assert.deepEqual(events, []);
});
