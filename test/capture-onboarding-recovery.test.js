// rec#5 C10, dot review of PR 266 (rec#10 6317416322): opening the first-run
// question survives interruption and races, the open question is bound to the
// settings version it opened with, and an answer whose response was lost reads
// back as what was saved. Synthetic only: temporary data directories, a
// recording Provider double, no FULI data directory, live Provider, port-2727
// service or client configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { CAPTURE_ONBOARDING_FORMAT, createCaptureOnboarding } from '../src/graphiti/capture-onboarding.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { beginFirstRunCapture } from '../src/setup/first-run-capture.js';
import { writeVersionedJsonFileAtomic } from '../src/storage/json-format.js';
import { fixture } from './fixtures/capture-project-fixture.js';

const SETUP_MODULE = new URL('../src/setup/first-run-capture.js', import.meta.url).href;

function setupPaths(f) {
  const dataDir = dirname(f.runtimeConfigPath);
  return { dataDir, graphRuntimeConfigPath: f.runtimeConfigPath,
    containerGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'container.json'),
    nativeGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'native.json'),
    nativePersonalDir: join(dataDir, 'native-runtime', 'personal') };
}

async function consoleRequest(f, method, body) {
  let sent;
  const request = { method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
  const response = { writeHead: status => { sent = { status }; }, setHeader: () => {}, end: text => { sent.body = JSON.parse(text); } };
  const path = method === 'PATCH' ? '/api/capture-policy' : '/api/capture-onboarding';
  await handleGraphApiRequest({ request, response, url: new URL(`http://127.0.0.1${path}`), app: f.app });
  return sent;
}

const policyFile = f => capturePolicyPathForRuntime(f.runtimeConfigPath);
const recordOf = async f => JSON.parse(await readFile(join(dirname(policyFile(f)), 'capture-onboarding.json'), 'utf8'));
const answer = (f, choice) => consoleRequest(f, 'POST', { choice });

// Runs one FULI process against the fixture's data directory.
function runProcess(script, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(paths)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
  });
}

test('an opening interrupted before recording is switched off resumes on the next run', async (t) => {
  const f = await fixture(t);
  const store = new CapturePolicyStore(policyFile(f));
  store.updateVersioned = () => { throw new Error('synthetic crash before the settings save'); };
  assert.throws(() => createCaptureOnboarding(store).begin(() => true), /synthetic crash/);
  assert.equal((await recordOf(f)).status, 'opening');
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: false }, 'nothing is asked until opening finishes');

  beginFirstRunCapture(setupPaths(f));
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: true });
  assert.equal(f.app.getCapturePolicy().enabled, false);
});

test('an opening interrupted after recording is switched off is never taken for an existing installation', async (t) => {
  const f = await fixture(t);
  const writes = [];
  const crashBeforePending = (path, record) => {
    writes.push(record.status);
    if (record.status === 'pending') throw new Error('synthetic crash between the two files');
    writeVersionedJsonFileAtomic(path, record, CAPTURE_ONBOARDING_FORMAT);
  };
  assert.throws(() => createCaptureOnboarding(new CapturePolicyStore(policyFile(f)), { writeRecord: crashBeforePending })
    .begin(() => true), /synthetic crash/);
  assert.deepEqual(writes, ['opening', 'pending']);
  assert.equal(f.app.getCapturePolicy().enabled, false, 'recording is already off');
  assert.equal(new CapturePolicyStore(policyFile(f)).neverSaved(), false, 'the settings exist now');

  beginFirstRunCapture(setupPaths(f));
  assert.equal((await recordOf(f)).status, 'pending');
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: true }, 'the new user is still asked');
});

test('setups racing in several processes open the question once', async (t) => {
  const f = await fixture(t);
  const paths = setupPaths(f);
  const script = `import { beginFirstRunCapture } from ${JSON.stringify(SETUP_MODULE)};
    beginFirstRunCapture(JSON.parse(process.argv.at(-1)));`;
  await Promise.all(Array.from({ length: 4 }, () => runProcess(script, paths)));
  const record = await recordOf(f);
  assert.equal(record.status, 'pending');
  const store = new CapturePolicyStore(policyFile(f));
  assert.equal(store.version(), record.settingsVersion, 'bound to the one settings save that opened it');
  assert.equal(store.read().enabled, false);
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: true });
});

test('answers racing in two processes: one saves, the other changes nothing', async (t) => {
  const f = await fixture(t);
  const paths = setupPaths(f);
  beginFirstRunCapture(paths);
  const script = choice => `import { captureOnboardingFor } from ${JSON.stringify(SETUP_MODULE)};
    const outcome = captureOnboardingFor(JSON.parse(process.argv.at(-1))).answer({ choice: ${JSON.stringify(choice)} }, { surface: 'terminal' });
    console.log(outcome.status + ':' + (outcome.choice ?? ''));`;
  const outcomes = await Promise.all([runProcess(script('all'), paths), runProcess(script('off'), paths)]);
  assert.deepEqual(outcomes.map(outcome => outcome.split(':')[0]).sort(), ['answered', 'gone']);
  const winner = outcomes.find(outcome => outcome.startsWith('answered')).split(':')[1];
  assert.equal(f.app.getCapturePolicy().enabled, winner === 'all');
  assert.equal((await recordOf(f)).choice, winner);
});

test('a change saved in the same millisecond closes the question', async (t) => {
  const f = await fixture(t);
  const fixed = () => '2026-10-21T08:00:00.000Z';
  createCaptureOnboarding(new CapturePolicyStore(policyFile(f), { now: fixed })).begin(() => true);
  new CapturePolicyStore(policyFile(f), { now: fixed }).update({ disabledSources: ['cursor'] });
  assert.equal(f.app.getCapturePolicy().updatedAt, fixed(), 'the same time as the opening save');
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: false });
  assert.equal((await answer(f, 'all')).body.status, 'gone');
  assert.deepEqual([f.app.getCapturePolicy().enabled, f.app.getCapturePolicy().disabledSources], [false, ['cursor']]);
});

test('a hand edit that keeps updatedAt closes the question and is never overwritten', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const saved = JSON.parse(await readFile(policyFile(f), 'utf8'));
  await writeFile(policyFile(f), JSON.stringify({ ...saved, disabledSources: ['codex'] }));
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: false });
  assert.equal((await answer(f, 'all')).body.status, 'gone');
  assert.deepEqual([f.app.getCapturePolicy().enabled, f.app.getCapturePolicy().disabledSources], [false, ['codex']]);
});

test('restoring the settings file as it was when the question opened keeps it closed', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const opened = await readFile(policyFile(f), 'utf8');
  assert.equal((await consoleRequest(f, 'PATCH', { enabled: true })).status, 200);
  await writeFile(policyFile(f), opened);
  assert.equal(f.app.getCapturePolicy().enabled, false, 'the old file is back, byte for byte');
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: false });
  assert.equal((await answer(f, 'all')).body.status, 'gone');
  assert.equal(f.app.getCapturePolicy().enabled, false);
});

test('an answer saved whose record could not be written reads back as answered', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const lostRecord = createCaptureOnboarding(f.store, { writeRecord: () => { throw new Error('synthetic disk error'); } });
  assert.equal(lostRecord.answer({ choice: 'all' }, { surface: 'console' }).status, 'answered');
  const read = await consoleRequest(f, 'GET');
  assert.deepEqual([read.status, read.body.ask, read.body.capturePolicy.enabled], [200, false, true]);
});

test('settings saved before the answer failed read back as saved, not as still off', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const update = f.store.update.bind(f.store);
  f.store.update = (...args) => { update(...args); throw new Error('synthetic failure after the settings save'); };
  await assert.rejects(answer(f, 'all'), /synthetic failure/);
  const read = await consoleRequest(f, 'GET');
  assert.deepEqual([read.body.ask, read.body.capturePolicy.enabled], [false, true]);
});

// dot review of PR 266 (rec#10 6317789066): another process's ordinary
// settings save between the opening's settings commit and its generation
// publish must never become the version the open question is bound to.
const POLICY_MODULE = new URL('../src/graphiti/capture-policy.js', import.meta.url).href;
const pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

test('a settings save by another process right after the opening commit is never bound to the question', async (t) => {
  const f = await fixture(t);
  const path = policyFile(f);
  const started = join(dirname(path), 'synthetic-writer-started');
  const script = `import { writeFileSync } from 'node:fs';
    import { CapturePolicyStore } from ${JSON.stringify(POLICY_MODULE)};
    const [path, started] = JSON.parse(process.argv.at(-1));
    writeFileSync(started, '');
    new CapturePolicyStore(path).update({ enabled: true });`;
  let writer = null;
  // The barrier: the first look at the settings file once the opening's save
  // (recording off) is on disk, which is where its generation is computed.
  const statFile = file => {
    if (!writer && existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).enabled === false) {
      writer = runProcess(script, [path, started]);
      for (let waited = 0; !existsSync(started) && waited < 20_000; waited += 20) pause(20);
      pause(1000);
    }
    return statSync(file, { bigint: true });
  };
  createCaptureOnboarding(new CapturePolicyStore(path, { statFile })).begin(() => true);
  assert.ok(writer, 'the other process saved at the barrier');
  await writer;

  const record = await recordOf(f);
  assert.equal(record.status, 'pending');
  assert.notEqual(new CapturePolicyStore(path).version(), record.settingsVersion, 'the question names the opening save only');
  assert.equal(f.app.getCapturePolicy().enabled, true, 'the other process saved after the opening');
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: false }, 'its change closed the question');
  assert.equal((await answer(f, 'off')).body.status, 'gone');
  assert.equal(f.app.getCapturePolicy().enabled, true, 'and is never overwritten');
});
