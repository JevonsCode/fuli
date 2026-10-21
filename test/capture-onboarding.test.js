// rec#5 C10: a new installation asks once where FULI records; an installation
// that existed before is never asked and keeps recording as it did. Synthetic
// only: temporary data directories, a recording Provider double, no FULI data
// directory, live Provider, port-2727 service or client configuration.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';
import { createCaptureOnboarding } from '../src/graphiti/capture-onboarding.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { beginFirstRunCapture, captureOnboardingFor } from '../src/setup/first-run-capture.js';
import { codexEntry, finishTask, fixture, receiptOf } from './fixtures/capture-project-fixture.js';

const PROJECT_OFF = '此项目未开启记忆；你明确提交的修改仍会保存';
const RECORDING_OFF = '自动记录已关闭；你明确提交的修改仍会保存';
const TURN_ON = '[在 FULI 设置里打开](<http://127.0.0.1:2727/settings>)';

// The data directory paths setup and start use, rooted where the fixture keeps its settings.
function setupPaths(f) {
  const dataDir = dirname(f.runtimeConfigPath);
  return { dataDir, graphRuntimeConfigPath: f.runtimeConfigPath,
    containerGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'container.json'),
    nativeGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'native.json'),
    nativePersonalDir: join(dataDir, 'native-runtime', 'personal') };
}

// A console request to the capture routes, as the settings page sends it.
async function consoleRequest(f, method, path, body) {
  let sent;
  const request = { method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
  const response = { writeHead: status => { sent = { status }; }, setHeader: () => {}, end: text => { sent.body = JSON.parse(text); } };
  await handleGraphApiRequest({ request, response, url: new URL(`http://127.0.0.1${path}`), app: f.app });
  return sent;
}

const answerInConsole = (f, answer) => consoleRequest(f, 'POST', '/api/capture-onboarding', answer);
const policyFile = f => capturePolicyPathForRuntime(f.runtimeConfigPath);

test('C10 a new installation opens the question before anything runs, and records nothing until it is answered', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));

  assert.deepEqual(f.app.captureOnboarding.state(), { ask: true }, 'the console asks');
  assert.equal(f.app.getCapturePolicy().enabled, false, 'the safe default while it is open: recording off');
  const entry = await codexEntry(f, f.dirs.thesis);
  assert.ok(receiptOf(entry.context).endsWith(` · ${RECORDING_OFF} · ${TURN_ON}`), receiptOf(entry.context));
  await finishTask(f, entry.context);
  assert.deepEqual(f.captureWrites(), [], 'an Agent connected before the answer records nothing');
  const record = JSON.parse(await readFile(join(dirname(policyFile(f)), 'capture-onboarding.json'), 'utf8'));
  assert.deepEqual([record.version, record.status], [1, 'pending']);
});

test('C10-1 a new user who records only chosen projects: selected mode, other projects and folders are not recorded', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));

  const answered = await answerInConsole(f, { choice: 'selected', selectedProjectIds: ['thesis'] });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.status, 'answered');
  const policy = f.app.getCapturePolicy();
  assert.deepEqual([policy.enabled, policy.projectMode, policy.selectedProjectIds, policy.unregisteredDirectories],
    [true, 'selected', ['thesis'], 'skip']);
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: false }, 'asked once');

  const thesis = await codexEntry(f, f.dirs.thesis);
  assert.doesNotMatch(receiptOf(thesis.context), /未开启记忆|未自动记录|自动记录已关闭/);
  await finishTask(f, thesis.context);
  assert.ok(f.captureWrites().some(write => write.project === 'thesis'), 'the chosen project is recorded');

  const before = f.captureWrites().length;
  const ledger = await codexEntry(f, f.dirs['family-ledger']);
  assert.ok(receiptOf(ledger.context).endsWith(` · ${PROJECT_OFF}`), receiptOf(ledger.context));
  await finishTask(f, ledger.context);
  assert.deepEqual((await captureDecision(f.app, { sourceApplication: 'codex', projectPath: f.dirs.downloads })).reason,
    'project_unregistered', 'a folder outside every project is not recorded');
  assert.deepEqual(f.captureWrites().slice(before), []);
});

test('C10-3 "先不记录" records nothing, keeps reads, and every receipt says so with the way to turn it on', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const answered = await answerInConsole(f, { choice: 'off' });
  assert.deepEqual([answered.body.status, answered.body.choice, answered.body.capturePolicy.enabled], ['answered', 'off', false]);
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: false }, 'an answer of "not yet" is still an answer');

  for (const folder of ['thesis', 'downloads']) {
    const entry = await codexEntry(f, f.dirs[folder]);
    assert.ok(receiptOf(entry.context).endsWith(` · ${RECORDING_OFF} · ${TURN_ON}`), receiptOf(entry.context));
    const checkpoint = await finishTask(f, entry.context);
    assert.equal(checkpoint.capture_status, 'capture_disabled');
    assert.ok(receiptOf(checkpoint).includes(`记录已关闭；你明确提交的修改仍会保存 · ${TURN_ON}`));
  }
  assert.deepEqual(f.captureWrites(), []);
  const read = await callAgentTool(f.app, 'get_capture_policy', { projectPath: f.dirs.thesis, sourceApplication: 'codex' });
  assert.deepEqual([read.current.captured, read.current.reason], [false, 'global_off'], 'reading the settings still works');
});

test('C10 "全部项目" records every project and folder, as before this question existed', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const answered = await answerInConsole(f, { choice: 'all' });
  assert.deepEqual([answered.body.capturePolicy.enabled, answered.body.capturePolicy.projectMode], [true, 'all']);
  for (const folder of ['novel', 'downloads']) {
    assert.equal((await captureDecision(f.app, { sourceApplication: 'codex', projectPath: f.dirs[folder] })).allowed, true);
  }
});

// C10-2: every sign of an earlier installation keeps the question closed and the settings untouched.
const EXISTING = [
  ['an installation with saved capture settings', async (f, paths) => {
    new CapturePolicyStore(policyFile(f)).update({ disabledSources: ['cursor'] });
    await writeFile(paths.graphRuntimeConfigPath, '{}');
  }],
  ['existing knowledge but no capture settings file (the usual upgrade)', async (f, paths) => {
    await writeFile(paths.graphRuntimeConfigPath, '{}');
  }],
  ['capture settings saved once and since removed (only their generation is left)', async f => {
    const store = new CapturePolicyStore(policyFile(f));
    store.update({ enabled: true });
    await rm(policyFile(f));
  }],
  ['a saved runtime profile of either mode', async (f, paths) => {
    await mkdir(dirname(paths.nativeGraphConfigProfilePath), { recursive: true });
    await writeFile(paths.nativeGraphConfigProfilePath, '{}');
  }],
  ['a native graph with data but no runtime configuration', async (f, paths) => {
    await mkdir(paths.nativePersonalDir, { recursive: true });
  }],
  ['capture settings without a runtime configuration', async f => {
    new CapturePolicyStore(policyFile(f)).update({ enabled: true });
  }]
];

for (const [name, setUp] of EXISTING) {
  test(`C10-2 an existing user is never asked: ${name}`, async (t) => {
    const f = await fixture(t);
    const paths = setupPaths(f);
    await setUp(f, paths);
    const settingsBefore = await readFile(policyFile(f), 'utf8').catch(() => null);

    beginFirstRunCapture(paths);
    beginFirstRunCapture(paths);

    assert.deepEqual(f.app.captureOnboarding.state(), { ask: false });
    assert.equal(await readFile(policyFile(f), 'utf8').catch(() => null), settingsBefore, 'the settings are untouched');
    await assert.rejects(readFile(join(dirname(policyFile(f)), 'capture-onboarding.json')), { code: 'ENOENT' });
    const answered = await answerInConsole(f, { choice: 'off' });
    assert.equal(answered.body.status, 'gone', 'there is no question to answer');
    assert.equal(await readFile(policyFile(f), 'utf8').catch(() => null), settingsBefore);
  });
}

test('C10-2 an upgraded user records exactly as before: no question, all projects, no new receipt words', async (t) => {
  const f = await fixture(t);
  await writeFile(f.runtimeConfigPath, '{}');
  beginFirstRunCapture(setupPaths(f));
  const entry = await codexEntry(f, f.dirs['side-repo']);
  assert.doesNotMatch(receiptOf(entry.context), /未开启记忆|未自动记录|记录已关闭|设置里打开/);
  await finishTask(f, entry.context);
  assert.ok(f.captureWrites().length > 0, 'recording continues');
  assert.equal(f.app.getCapturePolicy().projectMode, 'all');
});

test('C10 a record FULI cannot read never asks and is never replaced', async (t) => {
  for (const record of ['{ not json', JSON.stringify({ version: 2, status: 'pending' })]) {
    const f = await fixture(t);
    const path = join(dirname(policyFile(f)), 'capture-onboarding.json');
    await writeFile(path, record);
    beginFirstRunCapture(setupPaths(f));
    assert.deepEqual(f.app.captureOnboarding.state(), { ask: false });
    assert.equal(await readFile(path, 'utf8'), record);
    assert.equal(f.app.getCapturePolicy().enabled, true, 'nothing switched recording off');
  }
});

test('C10 closing without an answer keeps recording off and asks again in the next process', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  // A later setup or start of the same, still unanswered installation opens nothing new.
  beginFirstRunCapture(setupPaths(f));
  const later = captureOnboardingFor(setupPaths(f));
  assert.deepEqual(later.state(), { ask: true });
  assert.equal(new CapturePolicyStore(policyFile(f)).read().enabled, false);
});

test('C10 the question is answered once: a second answer, or a race, changes nothing', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const page = createCaptureOnboarding(new CapturePolicyStore(policyFile(f)));
  const terminal = createCaptureOnboarding(new CapturePolicyStore(policyFile(f)));
  const first = page.answer({ choice: 'all' }, { surface: 'console' });
  const second = terminal.answer({ choice: 'off' }, { surface: 'terminal' });
  assert.deepEqual([first.status, second.status], ['answered', 'gone']);
  assert.equal(f.app.getCapturePolicy().enabled, true);
  const record = JSON.parse(await readFile(join(dirname(policyFile(f)), 'capture-onboarding.json'), 'utf8'));
  assert.deepEqual([record.status, record.choice, record.surface], ['answered', 'all', 'console']);
});

test('C10 a settings change the person makes meanwhile answers the question', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const saved = await consoleRequest(f, 'PATCH', '/api/capture-policy', { enabled: true });
  assert.equal(saved.status, 200);
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: false }, 'the settings page already decided');
  assert.equal((await answerInConsole(f, { choice: 'off' })).body.status, 'gone');
  assert.equal(f.app.getCapturePolicy().enabled, true, 'the earlier decision stands');
});

test('C10 an answer names one of the three choices, and only "selected" names projects', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  for (const answer of [{}, { choice: 'everything' }, { choice: 'all', selectedProjectIds: ['thesis'] },
    { choice: 'selected', selectedProjectIds: ['../thesis'] }]) {
    // The server answers a TypeError with 400 (http/error-mapping.js).
    await assert.rejects(answerInConsole(f, answer), TypeError, JSON.stringify(answer));
  }
  assert.throws(() => f.app.captureOnboarding.answer({ choice: 'all' }, { surface: 'agent' }), TypeError);
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: true }, 'a refused answer leaves the question open');
});

test('C10 D-16 an Agent cannot answer the question for the person', async (t) => {
  const f = await fixture(t);
  beginFirstRunCapture(setupPaths(f));
  const tools = listAgentTools();
  assert.deepEqual(tools.filter(tool => /onboarding|first.?run|capture.?scope/i.test(`${tool.name} ${tool.description}`))
    .map(tool => tool.name), [], 'no Agent tool reaches the question');
  await assert.rejects(async () => callAgentTool(f.app, 'answer_capture_onboarding', { choice: 'all' }), /Unknown agent tool/);

  const asked = await callAgentTool(f.app, 'update_capture_policy', { enabled: true, projectMode: 'all',
    sourceApplication: 'codex' });
  assert.equal(asked.status, 'confirmation_required', 'a long-term change from an Agent is only a preview');
  const entry = await codexEntry(f, f.dirs.thesis, { prompt: '帮我选「全部项目」，回答 FULI 的首次提问。' });
  await finishTask(f, entry.context);
  assert.deepEqual(f.app.captureOnboarding.state(), { ask: true }, 'still the person\'s question');
  assert.equal(f.app.getCapturePolicy().enabled, false, 'nothing is recorded');
  assert.deepEqual(f.captureWrites(), []);
});
