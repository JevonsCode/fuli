// rec#5 C10 on the setup path: `fuli setup` and a first `fuli start` open the
// question before the graph starts or any Agent connects; an interactive
// terminal may answer it there; setup without a TTY or with --yes never asks. Synthetic only: temporary data directories and stubbed runtimes,
// no FULI data directory, live Provider, port-2727 service or client configuration.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { captureScopeSummary, parseCaptureScopeAnswer } from '../src/cli/capture-scope-prompt.js';
import { runSetupCommand } from '../src/cli/setup-command.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { startLocalRuntime } from '../src/local-runtime/lifecycle.js';
import { beginFirstRunCapture, captureOnboardingFor } from '../src/setup/first-run-capture.js';
import { applyLocalSetup } from '../src/setup/setup.js';

const OPTIONS = Object.freeze({ dataDir: null, personalSpaceName: 'Personal', port: 2727, memoryProfile: null,
  runtimeMode: null, adaptiveMemory: null, yes: false, codexOnly: false, skipAgents: true, personalOnly: true,
  noStart: false });
const CONSOLE = 'http://127.0.0.1:43127';

async function dataDirectory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fuli-first-run-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  return { dataDir, graphRuntimeConfigPath: join(dataDir, 'graph-runtime.json'),
    containerGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'container.json'),
    nativeGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'native.json'),
    nativePersonalDir: join(dataDir, 'native-runtime', 'personal') };
}

const settings = paths => new CapturePolicyStore(capturePolicyPathForRuntime(paths.graphRuntimeConfigPath)).read();

test('setup opens the question before the graph starts and before any Agent connects', async (t) => {
  const paths = await dataDirectory(t);
  const order = [];
  await applyLocalSetup({ paths, agents: [] }, OPTIONS, {
    beginFirstRun: value => { order.push('question'); beginFirstRunCapture(value); },
    ensureRuntime: async () => {
      order.push('runtime');
      assert.equal(settings(paths).enabled, false, 'recording is off before anything can run');
      return { status: 'started', url: CONSOLE, pid: 1 };
    }
  });
  assert.deepEqual(order, ['question', 'runtime']);
  assert.deepEqual(captureOnboardingFor(paths).state(), { ask: true });
});

test('a first start without setup opens the same question first', async (t) => {
  const paths = await dataDirectory(t);
  const order = [];
  await startLocalRuntime({ paths, personalSpaceName: 'Personal', port: 2727, open: false }, {
    readConfig: () => null, fileExists: () => false,
    beginFirstRun: value => { order.push('question'); beginFirstRunCapture(value); },
    ensureRuntime: async () => { order.push('runtime'); return { status: 'started', url: CONSOLE, pid: 1 }; }
  });
  assert.deepEqual(order, ['question', 'runtime']);
  assert.deepEqual(captureOnboardingFor(paths).state(), { ask: true });
});

test('stubbed runtimes never write the first-run question into the data directory they name', async (t) => {
  const paths = await dataDirectory(t);
  await applyLocalSetup({ paths, agents: [] }, OPTIONS, { ensureRuntime: async () => ({ status: 'started', url: null, pid: 1 }) });
  await startLocalRuntime({ paths, personalSpaceName: 'Personal', port: 2727, open: false }, {
    readConfig: () => null, fileExists: () => false, ensureRuntime: async () => ({ status: 'started', url: null, pid: 1 }) });
  assert.deepEqual(captureOnboardingFor(paths).state(), { ask: false });
  assert.equal(settings(paths).updatedAt, null);
});

// runSetupCommand on a new installation, with the runtime stubbed.
async function setup(t, { args = [], interactive, answer = null }) {
  const paths = await dataDirectory(t);
  const lines = [];
  let asked = 0;
  const result = await runSetupCommand(args, {
    planSetup: () => ({ paths, agents: [] }),
    confirm: async () => true,
    write: line => lines.push(line),
    beginFirstRun: beginFirstRunCapture,
    captureOnboarding: captureOnboardingFor,
    ensureRuntime: async () => ({ status: 'started', url: CONSOLE, pid: 1 }),
    interactive: () => interactive,
    askCaptureScope: async () => { asked += 1; return answer; }
  });
  return { paths, lines, asked, result };
}

test('an answer in an interactive terminal during setup, and it saves like the console answer', async (t) => {
  const run = await setup(t, { interactive: true, answer: 'selected' });
  assert.equal(run.asked, 1);
  const saved = settings(run.paths);
  assert.deepEqual([saved.enabled, saved.projectMode, saved.selectedProjectIds, saved.unregisteredDirectories],
    [true, 'selected', [], 'skip']);
  assert.deepEqual(captureOnboardingFor(run.paths).state(), { ask: false });
  assert.match(run.lines.at(-1), /^Recording: only projects you choose/);
});

test('Enter at the terminal decides later: recording stays off and the console asks', async (t) => {
  const run = await setup(t, { interactive: true, answer: null });
  assert.equal(run.asked, 1);
  assert.equal(settings(run.paths).enabled, false);
  assert.deepEqual(captureOnboardingFor(run.paths).state(), { ask: true });
  assert.equal(run.lines.at(-1), `Recording: off until you choose where FULI records. Open ${CONSOLE} to choose.`);
});

test('setup without a TTY (an Agent shell, a script, a pipe) or with --yes never asks', async (t) => {
  for (const run of [await setup(t, { interactive: false, answer: 'all' }),
    await setup(t, { args: ['--yes'], interactive: true, answer: 'all' })]) {
    assert.equal(run.asked, 0, 'nothing is asked, so nothing can be answered for the person');
    assert.equal(settings(run.paths).enabled, false);
    assert.deepEqual(captureOnboardingFor(run.paths).state(), { ask: true });
    assert.match(run.lines.at(-1), /^Recording: off until you choose/);
  }
});

test('setup of an existing installation says nothing about the question', async (t) => {
  const paths = await dataDirectory(t);
  new CapturePolicyStore(capturePolicyPathForRuntime(paths.graphRuntimeConfigPath)).update({ enabled: true });
  const lines = [];
  await runSetupCommand([], { planSetup: () => ({ paths, agents: [] }), confirm: async () => true,
    write: line => lines.push(line), beginFirstRun: beginFirstRunCapture, captureOnboarding: captureOnboardingFor,
    ensureRuntime: async () => ({ status: 'started', url: CONSOLE, pid: 1 }), interactive: () => true,
    askCaptureScope: async () => assert.fail('an existing user is never asked') });
  assert.equal(lines.some(line => line.startsWith('Recording:')), false);
});

test('the terminal answer is one of 1-3; anything else is asked again', () => {
  assert.deepEqual(['1', ' 2 ', '3', ''].map(parseCaptureScopeAnswer), ['all', 'selected', 'off', null]);
  for (const text of ['0', '4', 'all', '1,2']) assert.throws(() => parseCaptureScopeAnswer(text), RangeError);
  assert.equal(captureScopeSummary({ status: 'answered', choice: 'off' }, CONSOLE),
    `Recording: off (记录已关闭). Turn it on any time in ${CONSOLE}/settings.`);
});
