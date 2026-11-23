import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runTrayAction, stageReporter } from '../src/desktop/desktop-controller.js';
import {
  followStartupStages,
  startupStageMarker,
  startupStageWriter,
  withoutStageMarkers
} from '../src/local-runtime/startup-stage.js';
import { ensureGraphRuntime } from '../src/setup/graph-runtime.js';

const ASKED = { FULI_STAGE_MARKERS: '1' };

// What a terminal prints for a step.
function startupStageLine(stage, bound) {
  let line;
  startupStageWriter(value => { line = value; }, {})(stage, bound);
  return line;
}

// What a client reading a start's output takes from one line, or null.
async function readStartupMarker(text) {
  const stream = new PassThrough();
  const seen = [];
  followStartupStages(stream, (stage, bound) => seen.push({ stage, maxSeconds: bound.maxSeconds }));
  stream.write(`${text}\n`);
  await new Promise(resolve => setImmediate(resolve));
  return seen[0] ?? null;
}

// The step ids the JS module knows, read from the module itself.
function jsStages() {
  const source = readFileSync(new URL('../src/local-runtime/startup-stage.js', import.meta.url), 'utf8');
  const table = source.slice(source.indexOf('const STAGE_TEXT'), source.indexOf('});'));
  return [...table.matchAll(/^\s+(\w+): \{ zh:/gm)].map(([, id]) => id).sort();
}

// The step ids the desktop client words (desktop/flutter/lib/src/l10n/strings.dart `startupStage`).
function dartStages() {
  const source = readFileSync(new URL('../desktop/flutter/lib/src/l10n/strings.dart', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('String? startupStage(String? stage)'), source.indexOf('_ => null', source.indexOf('String? startupStage(')));
  return [...body.matchAll(/'(\w+)' => _t\(/g)].map(([, id]) => id).sort();
}

test('the terminal and the desktop client know the same startup steps', () => {
  const js = jsStages();
  assert.ok(js.length >= 10, js.join(', '));
  assert.deepEqual(dartStages(), js);
  for (const stage of js) assert.match(startupStageLine(stage), /^[^/]+… \/ .+…$/, stage);
  assert.throws(() => startupStageLine('made_up'), /Unknown startup stage/);
});

test('a step with a fixed wait says its limit, in the terminal and on the line a client reads', async () => {
  assert.equal(startupStageLine('console_start', { maxSeconds: 60 }), '正在打开控制台（最多 60 秒）… / Starting the console (up to 60 s)…');
  assert.deepEqual(await readStartupMarker(startupStageMarker('provider_wait', { maxSeconds: 240 })), { stage: 'provider_wait', maxSeconds: 240 });
  assert.deepEqual(await readStartupMarker(startupStageMarker('graph_setup')), { stage: 'graph_setup', maxSeconds: null });
});

test('a terminal reads sentences; a client that asked reads step lines', async () => {
  const written = [];
  startupStageWriter(value => written.push(value), {})('console_start');
  startupStageWriter(value => written.push(value), ASKED)('console_start');
  assert.equal(written[0], '正在打开控制台… / Starting the console…');
  assert.equal(await readStartupMarker(written[0]), null);
  assert.deepEqual(await readStartupMarker(written[1]), { stage: 'console_start', maxSeconds: null });
});

test('a result line, an unknown step or plain output is never read as a step', async () => {
  assert.equal(await readStartupMarker(JSON.stringify({ ok: false, stage: 'console_start' })), null);
  assert.equal(await readStartupMarker(JSON.stringify({ stage: 'made_up' })), null);
  assert.equal(await readStartupMarker('Fuli local services started.'), null);
  assert.equal(await readStartupMarker('not json {'), null);
  assert.throws(() => startupStageMarker('made_up'), /Unknown startup stage/);
});

test('the ask for step lines never reaches a process that outlives the start', () => {
  assert.deepEqual(withoutStageMarkers({ ...ASKED, HOME: '/h' }), { HOME: '/h' });
  const plain = { HOME: '/h' };
  assert.equal(withoutStageMarkers(plain), plain);
});

test('step lines are read from a stream split across chunks, with their limits', async () => {
  const stream = new PassThrough();
  const seen = [];
  followStartupStages(stream, (stage, bound) => seen.push([stage, bound.maxSeconds]));
  const waiting = startupStageMarker('provider_wait', { maxSeconds: 240 });
  stream.write(`${startupStageMarker('graph_start')}\nhalf of a `);
  stream.write(`line\n${waiting.slice(0, 8)}`);
  stream.write(`${waiting.slice(8)}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [['graph_start', null], ['provider_wait', 240]]);
});

function graphDeps(overrides = {}) {
  return {
    fileExists: () => false, readText: () => '', writeText: () => {}, secureFile: () => {},
    ensureDirectory: () => {}, readConfig: () => null, writeConfig: () => {}, writeRuntimeSettings: () => {},
    readAdaptiveSettings: () => ({ enabled: false }), writeAdaptiveSettings: () => {}, writeAdaptiveState: () => {},
    readState: () => null, writeState: () => {},
    ensureNativeRuntime: async () => ({ kind: 'native' }), startNativeProviders: async () => {},
    ensureContainerRuntime: async () => ({ kind: 'container' }), startProviders: () => {},
    recoverPorts: async settings => ({ settings, moves: [] }),
    desktopApp: () => false, isProcessAlive: pid => pid === 4242, webHealth: async () => true,
    consoleVersion: async () => null, discoverLanAddresses: () => [],
    spawnWebRuntime: () => ({ pid: 4242, unref() {} }),
    fetch: fakeProvider(), wait: async () => {}, now: Date.now,
    ...overrides
  };
}

const PATHS = {
  dataDir: '/x/data', graphRuntimeConfigPath: '/x/data/graph-runtime.json',
  graphRuntimeStatePath: '/x/data/graph-runtime-state.json', graphEnvPath: '/x/data/graph.env',
  runtimeSettingsPath: '/x/data/runtime-settings.json', logPath: '/x/data/console.log', serverPath: '/x/pkg/server.js'
};

test('a native start reports the phases it really enters, where the native runtime waits', async () => {
  const stages = [];
  await ensureGraphRuntime({
    paths: PATHS, personalSpaceName: '我', personalOnly: true, runtimeMode: 'native',
    onStage: (stage, bound) => stages.push(bound?.maxSeconds ? `${stage}:${bound.maxSeconds}` : stage)
  }, graphDeps({
    // The native start reports its own waits (runtime.js startUnlocked).
    startNativeProviders: async (_paths, _env, options) => {
      options.onStage('graph_start'); options.onStage('database_wait'); options.onStage('provider_wait');
    }
  }));
  // graph_start and provider_wait are not repeated, and the native Provider
  // wait gets no fixed limit it does not have.
  assert.deepEqual(stages, ['graph_runtime', 'graph_start', 'database_wait', 'provider_wait', 'graph_setup',
    'console_start', 'console_start:60']);
});

test('a container start waits for each Provider in turn, and says the whole of that limit', async () => {
  const stages = [];
  await ensureGraphRuntime({
    paths: PATHS, personalSpaceName: '我', personalOnly: false, runtimeMode: 'container',
    onStage: (stage, bound) => stages.push(bound?.maxSeconds ? `${stage}:${bound.maxSeconds}` : stage)
  }, graphDeps());
  assert.ok(stages.includes('provider_wait:240'), stages.join(', '));
});

test('a start that waits for another start says so, with that wait\'s limit', async () => {
  const { startLocalRuntime } = await import('../src/local-runtime/lifecycle.js');
  const stages = [];
  await startLocalRuntime({ paths: PATHS, onStage: (stage, bound) => stages.push(`${stage}:${bound?.maxSeconds}`) }, {
    lockStart: (_dataDir, onWait) => { onWait(); return () => {}; },
    readConfig: () => null, fileExists: () => true, ensureRuntime: async () => ({ status: 'started', url: 'http://127.0.0.1:2727', pid: 1 })
  });
  assert.deepEqual(stages, ['start_wait:300']);
});

test('the desktop controller reports its own steps, and names the one that failed', async () => {
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
  // The look after a failure is not a step of the start.
  assert.deepEqual(stages, ['first_setup', 'graph_start', 'provider_wait']);
});

test('a start whose commands all finished but FULI does not run names no step it was stuck at', async () => {
  const result = await runTrayAction('start', trayContext(), {
    runCli: async (_context, args, onStage) => {
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ status: 'stopped' }), stderr: '' };
      onStage('console_start');
      return { code: 0, stdout: '', stderr: '' };
    },
    portBlocked: async () => false, otherConsole: () => null, holdAdoption: () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, undefined);
  assert.match(result.error, /没有进入运行状态/);
});

test('the controller writes step lines only for a client that asks for them', () => {
  const lines = [];
  stageReporter(ASKED, line => lines.push(line))('first_setup');
  assert.deepEqual(lines, [`${startupStageMarker('first_setup')}\n`]);
  // The updaters, acceptance runs and smoke scripts read the whole output as
  // one JSON result: without the ask, nothing but that result is written.
  const quiet = [];
  stageReporter({}, line => quiet.push(line))('first_setup');
  assert.deepEqual(quiet, []);
});

function trayContext() {
  return { packageRoot: '/x/pkg', dataDir: '/x/fuli-test-data-that-does-not-exist', nodePath: '/x/node', cliPath: '/x/pkg/src/cli.js' };
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
