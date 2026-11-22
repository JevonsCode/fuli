import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { followStageMarkers, runTrayAction, stageReporter } from '../src/desktop/desktop-controller.js';
import {
  isStartupStage,
  readStartupStageMarker,
  STAGE_MARKER_ENV,
  STARTUP_STAGES,
  startupStageLine,
  startupStageMarker,
  startupStageWriter
} from '../src/local-runtime/startup-stage.js';
import { ensureGraphRuntime } from '../src/setup/graph-runtime.js';

test('every stage has a sentence in both languages', () => {
  for (const stage of STARTUP_STAGES) {
    const line = startupStageLine(stage);
    assert.match(line, /^[^/]+… \/ .+…$/, `${stage}: ${line}`);
    assert.ok(isStartupStage(stage));
  }
  assert.equal(isStartupStage('made_up'), false);
  assert.throws(() => startupStageLine('made_up'), /Unknown startup stage/);
});

test('a terminal reads sentences; a client reading along reads marker lines', () => {
  const written = [];
  startupStageWriter(value => written.push(value), {})('console_start');
  startupStageWriter(value => written.push(value), { [STAGE_MARKER_ENV]: '1' })('console_start');
  assert.equal(written[0], '正在打开控制台… / Starting the console…');
  assert.equal(readStartupStageMarker(written[0]), null);
  assert.equal(readStartupStageMarker(written[1]), 'console_start');
});

test('a result line is never read as a stage, and an unknown stage is ignored', () => {
  assert.equal(readStartupStageMarker(JSON.stringify({ ok: false, stage: 'console_start' })), null);
  assert.equal(readStartupStageMarker(JSON.stringify({ stage: 'made_up' })), null);
  assert.equal(readStartupStageMarker('Fuli local services started.'), null);
  assert.equal(readStartupStageMarker('not json {'), null);
  assert.throws(() => startupStageMarker('made_up'), /Unknown startup stage/);
});

test('stage markers are read from a stream split across chunks', async () => {
  const stream = new PassThrough();
  const seen = [];
  followStageMarkers(stream, stage => seen.push(stage));
  const waiting = startupStageMarker('provider_wait');
  stream.write(`${startupStageMarker('graph_start')}\nhalf of a `);
  stream.write(`line\n${waiting.slice(0, 8)}`);
  stream.write(`${waiting.slice(8)}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['graph_start', 'provider_wait']);
});

test('a start reports the phases it really enters, in order', async () => {
  const stages = [];
  const paths = {
    dataDir: '/x/data', graphRuntimeConfigPath: '/x/data/graph-runtime.json',
    graphRuntimeStatePath: '/x/data/graph-runtime-state.json', graphEnvPath: '/x/data/graph.env',
    runtimeSettingsPath: '/x/data/runtime-settings.json', logPath: '/x/data/console.log',
    serverPath: '/x/pkg/server.js'
  };
  await ensureGraphRuntime({
    paths, personalSpaceName: '我', personalOnly: true, runtimeMode: 'native', onStage: stage => stages.push(stage)
  }, {
    fileExists: () => false, readText: () => '', writeText: () => {}, secureFile: () => {},
    ensureDirectory: () => {}, readConfig: () => null, writeConfig: () => {}, writeRuntimeSettings: () => {},
    readAdaptiveSettings: () => ({ enabled: false }), writeAdaptiveSettings: () => {}, writeAdaptiveState: () => {},
    readState: () => null, writeState: () => {},
    ensureNativeRuntime: async () => ({ kind: 'native' }), startNativeProviders: async () => {},
    recoverPorts: async settings => ({ settings, moves: [] }),
    desktopApp: () => false, isProcessAlive: pid => pid === 4242, webHealth: async () => true,
    consoleVersion: async () => null, discoverLanAddresses: () => [],
    spawnWebRuntime: () => ({ pid: 4242, unref() {} }),
    fetch: fakeProvider(), wait: async () => {}, now: Date.now
  });
  assert.deepEqual(stages, ['graph_runtime', 'graph_start', 'provider_wait', 'graph_setup', 'console_start']);
});

test('the desktop controller reports its own steps and names the one that failed', async () => {
  const stages = [];
  const result = await runTrayAction('start', trayContext(), {
    onStage: stage => stages.push(stage),
    runCli: async (_context, args, onStage) => {
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ status: 'stopped' }), stderr: '' };
      onStage('graph_start');
      onStage('provider_wait');
      return { code: 1, stdout: '', stderr: 'Graphiti provider did not become ready' };
    },
    portBlocked: async () => false, otherConsole: () => null, holdAdoption: () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'provider_wait');
  assert.match(result.error, /did not become ready/);
  assert.deepEqual(stages, ['first_setup', 'graph_start', 'provider_wait', 'checking']);
});

test('the controller writes one marker line per step for its client', () => {
  const lines = [];
  stageReporter(line => lines.push(line))('first_setup');
  assert.deepEqual(lines, [`${startupStageMarker('first_setup')}\n`]);
});

function trayContext() {
  return { packageRoot: '/x/pkg', dataDir: '/x/data', nodePath: '/x/node', cliPath: '/x/pkg/src/cli.js' };
}

// Enough of a Provider for a first start: health, bootstrap, spaces and the
// identity upgrade all answer.
function fakeProvider() {
  return async (url) => ({
    ok: true,
    json: async () => url.endsWith('/v1/spaces')
      ? []
      : { status: 'ready', access_token: 'token', principal_id: 'p1', id: 's1', name: '我', kind: 'personal' }
  });
}
