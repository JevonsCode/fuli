import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAgentWorkflows } from '../src/agent-workflows/port.js';
import { AGENT_WORKFLOWS_FORMAT } from '../src/agent-workflows/store.js';
import { writeArtifactFiles } from '../acceptance/skill-paired-eval/artifacts.js';
import { createClient, parseEventStream, summarizeEvidence } from '../acceptance/skill-paired-eval/clients.js';
import { createFixtureStore, FIXTURE_OWNER } from '../acceptance/skill-paired-eval/fixture.js';
import { measureNegativeControl, observeWorkspace } from '../acceptance/skill-paired-eval/grading.js';
import { evaluateSelectedWorkflow } from '../acceptance/skill-paired-eval/runner.js';
import { renderReport } from '../acceptance/skill-paired-eval/report.js';
import { loadScenario, safeRelativePath, safeRunDirectoryName, validateScenario } from '../acceptance/skill-paired-eval/scenario.js';
import { listStoredWorkflows, readStoredWorkflow } from '../acceptance/skill-paired-eval/selection.js';
import { skillMarkdown } from '../acceptance/skill-paired-eval/skill.js';

const RUN = fileURLToPath(new URL('../acceptance/skill-paired-eval/run.js', import.meta.url));
const CHANGELOG_SCENARIO = fileURLToPath(new URL('../acceptance/skill-paired-eval/scenarios/changelog.json', import.meta.url));

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-skill-eval-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixtureStore(t) {
  const directory = tempDir(t);
  const path = join(directory, 'agent-workflows.sqlite');
  const fixture = createFixtureStore({ path });
  return { directory, path, ...fixture };
}

function addSecondWorkflow(path) {
  const workflows = createAgentWorkflows({ path, newId: () => 'workflow-unrelated' });
  try {
    workflows.propose(FIXTURE_OWNER, { name: 'Unrelated escape hatch',
      purpose: 'An unrelated stored workflow that must not enter the selected pair.',
      steps: [{ title: 'Ignore the task' }, { title: 'Write nothing' }], source: 'agent' });
    workflows.decide({ personalSpaceId: FIXTURE_OWNER.personalSpaceId, workflowId: 'workflow-unrelated',
      decision: 'confirm', version: 1 });
    return 'workflow-unrelated';
  } finally {
    workflows.close();
  }
}

function addChangelogWorkflow(path) {
  const workflows = createAgentWorkflows({ path, newId: () => 'workflow-changelog' });
  try {
    workflows.propose(FIXTURE_OWNER, { name: 'Changelog prefix',
      purpose: 'Add a pending changelog entry with the repository prefix.',
      steps: [{ title: 'Read PACKAGE' }, { title: 'Prefix the entry with [fix]' }], source: 'agent' });
    workflows.decide({ personalSpaceId: FIXTURE_OWNER.personalSpaceId, workflowId: 'workflow-changelog',
      decision: 'confirm', version: 1 });
    return 'workflow-changelog';
  } finally {
    workflows.close();
  }
}

function addLessonWorkflow(path) {
  const workflows = createAgentWorkflows({ path, newId: () => 'workflow-lesson' });
  try {
    workflows.propose(FIXTURE_OWNER, {
      name: 'Lesson workflow',
      purpose: 'Apply the stored lesson to a small text change.',
      source: 'lesson',
      steps: [{ title: 'Read the note', detail: 'Read the synthetic note before changing anything.' }],
      workMap: { inputs: ['A note'], outputs: ['A changed file'], acceptance: ['The changed file matches the note'] },
      lesson: { trigger: 'When a synthetic note asks for a change', scope: 'Only the synthetic fixture project',
        pitfalls: ['Do not skip reading the note'], acceptanceEvidence: ['The note was applied'] },
      delivery: { conversationId: 'conversation-1', revision: 0 },
      approval: { relayedBy: 'synthetic-fla', words: '下次也这样做', messageRef: { source: 'test', taskId: 'task-1' } }
    });
    return 'workflow-lesson';
  } finally {
    workflows.close();
  }
}

function providerConfig(directory) {
  const path = join(directory, 'provider.json');
  writeFileSync(path, `${JSON.stringify({ provider: { synthetic: { npm: '@ai-sdk/openai-compatible',
    options: { apiKey: 'not-used' } } } }, null, 2)}\n`);
  return path;
}

function fakeClient(directory) {
  const path = join(directory, 'fake-opencode');
  writeFileSync(path, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "if (process.argv[2] === '--version') { process.stdout.write('opencode v2.2.5\\n'); process.exit(0); }",
    "fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));",
    "fs.writeFileSync('pwd.txt', process.env.PWD || '');",
    "process.stdout.write(JSON.stringify({ type: 'tool_use', part: { id: 'call-1', tool: 'skill', "
      + "state: { status: 'completed', input: { id: 'release-tag-convention' } } } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', "
      + "text: JSON.stringify({ files: { 'answer.txt': '42\\n' } }) } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', "
      + "tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 4 } }, "
      + "providerID: 'synthetic', modelID: 'model-v2' } }) + '\\n');",
    ''
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

function event(type, part, extra = {}) {
  return JSON.stringify({ type, timestamp: 1, ...extra, part: { type, ...part } });
}

// Pure evidence from synthetic native event lines: no process, no shebang, so
// it runs the same on Linux and Windows.
function evidenceFor(lines, { selection = null, selectedSkill = null, model = null } = {}) {
  const stream = parseEventStream(lines.join('\n'));
  return summarizeEvidence({ selection, selectedSkill, stream, model });
}

function armRecord(arm, { pass, evidence, durationMs, changedPaths = [] }) {
  return {
    arm,
    task: 'task',
    pass,
    corrections: { count: null, unavailable: 'The client did not expose correction events.' },
    durationMs,
    changedPaths,
    grading: { checks: [{ type: 'client-completed', pass: pass === true }] },
    evidence,
    unavailable: []
  };
}

function reportResult({ positiveOff, positiveOn, negativeOn, negativeControl }) {
  return {
    selection: { workflowId: 'workflow-synthetic', version: 1, selectionId: 'workflow-synthetic@1',
      name: 'Synthetic workflow', purpose: 'Synthetic purpose', status: 'active', active: true,
      confirmed: true, confirmedBy: 'person', confirmedAt: '2026-01-01T00:00:00.000Z',
      source: 'agent', createdBy: 'agent', storeFile: 'agent-workflows.sqlite', usedWorkflowCount: 1,
      steps: [{ title: 'Step' }] },
    setup: { scenario: 'Synthetic', scenarioFiles: ['NOTE.md'], positiveTask: 'p', negativeTask: 'n',
      client: { name: 'synthetic-client', version: '1' }, isolation: 'Synthetic isolated setup.' },
    mode: 'live_client', evidenceKind: 'live_client', liveClient: true,
    arms: { positiveOff, positiveOn, negativeOn },
    pair: { effect: 'on_only', offPass: positiveOff.pass, onPass: positiveOn.pass },
    negativeControl, storeUnchanged: true, unavailable: [], runDirectory: '/tmp/run'
  };
}

test('the compact index lists a genuine saved workflow; detail reads one version without writing', t => {
  const fixture = fixtureStore(t);
  addSecondWorkflow(fixture.path);
  const before = readFileSync(fixture.path);
  const listed = listStoredWorkflows(fixture.path);
  assert.equal(listed.length, 2);
  const selected = listed.find(item => item.workflowId === fixture.workflowId);
  assert.deepEqual([selected.status, selected.activeVersion, selected.shownVersion, selected.stepCount],
    ['active', 1, 1, 3]);
  assert.equal(Object.hasOwn(selected, 'steps'), false, 'the compact index carries no steps');

  const read = readStoredWorkflow(fixture.path, fixture.workflowId);
  assert.deepEqual([read.version, read.active, read.confirmed, read.confirmedBy], [1, true, true, 'person']);
  assert.equal(read.steps.length, 3);
  assert.match(skillMarkdown(read), /prefixed with rel-/);
  assert.deepEqual(readFileSync(fixture.path), before, 'reading the store changes no byte');
});

test('selection refuses a store it cannot read read-only instead of migrating it', t => {
  const directory = tempDir(t);
  const wrong = join(directory, 'wrong.sqlite');
  const database = new DatabaseSync(wrong);
  database.exec('PRAGMA user_version = 1');
  database.close();
  assert.throws(() => listStoredWorkflows(wrong),
    new RegExp(`format 1; this evaluation reads format ${AGENT_WORKFLOWS_FORMAT.version}`));
  assert.throws(() => readStoredWorkflow(join(directory, 'missing.sqlite'), 'workflow-x'), /No Agent workflow store/);
  assert.throws(() => readStoredWorkflow(wrong, 'workflow-x'), /format 1/);
});

test('a stored lesson and work map are read and rendered with its steps', async t => {
  const fixture = fixtureStore(t);
  addLessonWorkflow(fixture.path);
  const selection = readStoredWorkflow(fixture.path, 'workflow-lesson');
  assert.equal(selection.lesson.trigger, 'When a synthetic note asks for a change');
  assert.deepEqual(selection.lesson.pitfalls, ['Do not skip reading the note']);
  assert.deepEqual(selection.workMap.acceptance, ['The changed file matches the note']);
  const skill = skillMarkdown(selection);
  for (const expected of ['When a synthetic note asks for a change', 'Only the synthetic fixture project',
    'Do not skip reading the note', 'The note was applied', 'The changed file matches the note', 'Read the note']) {
    assert.match(skill, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
  const result = await evaluateSelectedWorkflow({ selection, out: join(fixture.directory, 'results'),
    client: createClient({ mode: 'deterministic' }), pairId: 'lesson-pair' });
  const report = renderReport(result);
  for (const expected of ['When a synthetic note asks for a change', 'Only the synthetic fixture project',
    'Do not skip reading the note', 'The note was applied', 'The changed file matches the note', 'Read the note']) {
    assert.ok(report.includes(expected), `report should include ${expected}`);
  }
});

test('one selected workflow is run off and on on the same task, with no store write or recorded run', async t => {
  const fixture = fixtureStore(t);
  const unrelated = addSecondWorkflow(fixture.path);
  const before = readFileSync(fixture.path);
  const selection = readStoredWorkflow(fixture.path, fixture.workflowId);
  const result = await evaluateSelectedWorkflow({ selection, out: join(fixture.directory, 'results'),
    client: createClient({ mode: 'deterministic' }), pairId: 'pair-1' });

  assert.equal(result.mode, 'deterministic');
  assert.equal(result.liveClient, false);
  assert.equal(result.evidenceKind, 'deterministic_seam');
  assert.equal(result.selection.usedWorkflowCount, 1);
  assert.equal(result.arms.positiveOff.pass, false);
  assert.equal(result.arms.positiveOn.pass, true);
  assert.equal(result.pair.effect, 'on_only');
  assert.equal(result.arms.positiveOff.files['release.txt'].text.trim(), 'v1.4.0');
  assert.equal(result.arms.positiveOn.files['release.txt'].text.trim(), 'rel-1.4.0');
  assert.deepEqual(result.arms.positiveOn.skill,
    { used: true, workflowId: fixture.workflowId, version: 1, selectionId: `${fixture.workflowId}@1` });
  assert.notEqual(result.arms.positiveOn.skill.workflowId, unrelated);
  assert.equal(result.arms.positiveOn.corrections.count, null);
  assert.match(result.arms.positiveOn.corrections.unavailable, /unknown/);
  assert.equal(result.arms.positiveOn.evidence.providerContact, false);
  assert.equal(result.negativeControl.measured, true);
  assert.equal(result.negativeControl.triggered, false);
  assert.equal(result.negativeControl.pass, true);
  assert.equal(result.storeUnchanged, true);
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(readFileSync(fixture.path), before, 'the workflow store is byte-for-byte unchanged');

  const database = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_workflow_runs').get().count, 0);
  } finally { database.close(); }
  const saved = JSON.parse(readFileSync(join(result.runDirectory, 'result.json'), 'utf8'));
  assert.equal(saved.arms.positiveOn.pass, true);
  assert.equal(saved.selection.storeFile, 'agent-workflows.sqlite');
  assert.equal(Object.hasOwn(saved.selection, 'store'), false, 'the result names the store file, not a local path');
});

test('the negative control reports a mistaken trigger from the files the client actually changed', t => {
  const directory = tempDir(t);
  writeFileSync(join(directory, 'answer.txt'), '42\n');
  writeFileSync(join(directory, 'release.txt'), 'rel-1.4.0\n');
  const observation = observeWorkspace({ directory, baseline: {}, exitCode: 0 });
  const control = measureNegativeControl(validateScenario({
    files: {},
    positive: { id: 'p', prompt: 'p', checks: [{ type: 'file-equals', path: 'release.txt', value: 'rel-1.4.0' }] },
    negative: { id: 'n', prompt: 'n', checks: [{ type: 'file-equals', path: 'answer.txt', value: '42' }],
      forbidden: { files: ['release.txt'], markers: ['rel-'] } }
  }).negative, observation);
  assert.equal(control.measured, true);
  assert.equal(control.triggered, true);
  assert.equal(control.pass, false);
  assert.deepEqual(control.triggeredBy.files, ['release.txt']);
  assert.ok(control.triggeredBy.markers.includes('rel-'));
});

test('symbolic links and non-regular files are skipped, not read as evidence', { skip: process.platform === 'win32' }, t => {
  const directory = tempDir(t);
  const outside = join(directory, 'outside.txt');
  writeFileSync(outside, 'SECRET\n');
  const workspace = join(directory, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'real.txt'), 'ok\n');
  symlinkSync(outside, join(workspace, 'link.txt'));
  const observation = observeWorkspace({ directory: workspace, baseline: {}, exitCode: 0 });
  assert.equal(observation.files['link.txt'], undefined);
  assert.deepEqual(observation.files['real.txt'].text, 'ok\n');
  assert.ok(observation.skipped.some(item => item.path === 'link.txt' && item.reason === 'symbolic link'));
});

test('the artifact writer refuses a symbolic link and a path outside the workspace', { skip: process.platform === 'win32' }, t => {
  const directory = tempDir(t);
  const outside = join(directory, 'outside.txt');
  writeFileSync(outside, 'secret\n');
  const workspace = join(directory, 'workspace');
  mkdirSync(workspace);
  symlinkSync(outside, join(workspace, 'link.txt'));
  assert.throws(() => writeArtifactFiles(workspace, { 'link.txt': 'x' }), /symbolic link/);
  assert.throws(() => writeArtifactFiles(workspace, { '../escape.txt': 'x' }), /relative|workspace|segment/);
});

test('a scenario is validated before any output directory is written', t => {
  const fixture = fixtureStore(t);
  const directory = tempDir(t);
  const bad = join(directory, 'bad.json');
  writeFileSync(bad, JSON.stringify({ files: { '../escape.txt': 'x' },
    positive: { id: 'p', prompt: 'p', checks: [{ type: 'file-equals', path: 'x.txt', value: 'x' }] },
    negative: { id: 'n', prompt: 'n', checks: [{ type: 'file-equals', path: 'y.txt', value: 'y' }] } }));
  const out = join(directory, 'never-written');
  const run = spawnSync(process.execPath, [RUN, '--store', fixture.path, '--workflow-id', fixture.workflowId,
    '--scenario', bad, '--mode', 'deterministic', '--out', out], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Invalid scenario/);
  assert.equal(existsSync(out), false, 'the output directory is not created for an invalid scenario');

  for (const files of [{ '/abs.txt': 'x' }, { 'a/../b.txt': 'x' }, { 'a\\b.txt': 'x' }]) {
    assert.throws(() => validateScenario({ files,
      positive: { id: 'p', prompt: 'p', checks: [{ type: 'file-equals', path: 'x.txt', value: 'x' }] },
      negative: { id: 'n', prompt: 'n', checks: [{ type: 'file-equals', path: 'y.txt', value: 'y' }] } }),
    /Invalid scenario/);
  }
  assert.throws(() => validateScenario(JSON.parse('{"files":{"__proto__":"x"},'
    + '"positive":{"id":"p","prompt":"p","checks":[{"type":"file-equals","path":"x.txt","value":"x"}]},'
    + '"negative":{"id":"n","prompt":"n","checks":[{"type":"file-equals","path":"y.txt","value":"y"}]}}')),
  /Invalid scenario/);
  assert.throws(() => validateScenario({ files: {},
    positive: { id: 'p', prompt: 'p', checks: [{ type: 'execute', path: 'x' }] },
    negative: { id: 'n', prompt: 'n', checks: [{ type: 'file-equals', path: 'y.txt', value: 'y' }] } }),
  /must be one of/);
  assert.throws(() => loadScenario(join(directory, 'missing.json')), /Cannot read scenario/);
});

test('a second unrelated scenario runs through the real CLI instead of the fixture', t => {
  const directory = tempDir(t);
  const store = join(directory, 'agent-workflows.sqlite');
  addChangelogWorkflow(store);
  const out = join(directory, 'results');
  const run = spawnSync(process.execPath, [RUN, '--store', store, '--workflow-id', 'workflow-changelog',
    '--scenario', CHANGELOG_SCENARIO, '--mode', 'deterministic', '--out', out, '--pair-id', 'changelog-pair'],
  { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(readFileSync(join(out, 'changelog-pair', 'result.json'), 'utf8'));
  assert.equal(result.selection.workflowId, 'workflow-changelog');
  assert.equal(result.setup.scenario, 'Changelog entry prefix');
  assert.deepEqual(result.setup.scenarioFiles, ['CHANGELOG.md', 'PACKAGE']);
  assert.equal(result.arms.positiveOn.files['CHANGELOG.md'].text,
    '# Changelog\n\n## [fix] 2.3.1\n- Pending.\n\n## 2.3.0\n- Fixed retry handling.\n');
  assert.match(result.arms.positiveOff.files['CHANGELOG.md'].text, /v2\.3\.1/);
  assert.equal(result.arms.positiveOn.files['release.txt'], undefined);
  assert.equal(result.pair.effect, 'on_only');
  assert.equal(result.negativeControl.pass, true);
});

test('a missing client command is unavailable on every arm, never a pass', async t => {
  const fixture = fixtureStore(t);
  const selection = readStoredWorkflow(fixture.path, fixture.workflowId);
  const client = {
    identity: { name: 'missing-client', version: null, evidenceKind: 'live_client', live: true },
    run: async () => { throw Object.assign(new Error('The client command was not found'), { code: 'client_unavailable' }); }
  };
  const result = await evaluateSelectedWorkflow({ selection, out: join(fixture.directory, 'results'),
    client, pairId: 'pair-unavailable' });
  assert.equal(result.pair.onPass, null);
  assert.equal(result.pair.effect, 'unknown');
  assert.equal(result.negativeControl.measured, false);
  assert.equal(result.arms.positiveOff.unavailable.length, 1);
  assert.equal(result.arms.positiveOn.unavailable.length, 1);
  assert.ok(result.unavailable.length >= 2);
});

test('the OpenCode adapter rejects shell wrappers and a missing native command', t => {
  const directory = tempDir(t);
  const provider = providerConfig(directory);
  assert.throws(() => createClient({ mode: 'opencode', model: 'synthetic/model', command: 'opencode.cmd',
    providerConfig: provider }), /shell wrapper/);
  assert.throws(() => createClient({ mode: 'opencode', model: 'synthetic/model', command: 'OPENCODE.BAT',
    providerConfig: provider }), /shell wrapper/);
  assert.throws(() => createClient({ mode: 'opencode', model: 'synthetic/model',
    command: join(tmpdir(), 'fuli-no-such-opencode-command'), providerConfig: provider }), /not found/);
});

test('the live adapter preserves a quoted prompt argv and reads Skill/artifact evidence',
  { skip: process.platform === 'win32' }, async t => {
    const fixture = fixtureStore(t);
    const directory = tempDir(t);
    const selection = readStoredWorkflow(fixture.path, fixture.workflowId);
    const workspace = tempDir(t);
    const client = createClient({ mode: 'opencode', model: 'synthetic/model',
      command: fakeClient(directory), providerConfig: providerConfig(directory) });
    const task = { id: 'quoted', kind: 'positive',
      prompt: 'Echo "double" and \'single\' and --session=evil without changing anything.', checks: [] };
    const result = await client.run({ task, selection, workspace, files: {} });
    const argv = JSON.parse(readFileSync(join(workspace, 'argv.json'), 'utf8'));
    assert.deepEqual(argv.slice(0, 6), ['run', '--standalone', '--format', 'json', '--model', 'synthetic/model']);
    assert.equal(argv.includes('--continue'), false);
    assert.equal(argv.includes('--session'), false);
    assert.equal(argv.includes('-c'), false);
    assert.equal(argv.at(-1).includes('Echo "double" and \'single\' and --session=evil'), true);
    // OpenCode resolves the project from PWD, so an arm must start with PWD at
    // its own workspace instead of inheriting the caller's directory.
    assert.equal(readFileSync(join(workspace, 'pwd.txt'), 'utf8'), workspace);
    assert.equal(result.artifacts.files['answer.txt'], '42\n');
    assert.deepEqual(JSON.parse(result.answerText).files, result.artifacts.files);
    assert.equal(result.evidence.skillRead, true);
    assert.equal(result.evidence.skillCallStatus, 'completed');
    assert.equal(result.evidence.providerContact, true);
    assert.equal(result.evidence.upstreamExecution, 'confirmed');
    assert.equal(result.evidence.requestedModel, 'synthetic/model');
    assert.equal(result.evidence.reportedModel, 'synthetic/model-v2');
    assert.equal(result.evidence.reportedModelSource, 'step_events');
    assert.deepEqual(result.evidence.tokens, { source: 'client-reported', steps: 1, input: 11, output: 7,
      reasoning: 2, cacheRead: 3, cacheWrite: 4 });
    assert.deepEqual(result.evidence.toolCalls.map(call => call.tool), ['skill']);
  });

test('the CLI lists and runs the fixture through the normal single entry point', t => {
  const fixture = fixtureStore(t);
  const listed = spawnSync(process.execPath, [RUN, '--store', fixture.path, '--list'],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(fixture.workflowId));
  assert.match(listed.stdout, /Release tag convention/);
  assert.doesNotMatch(listed.stdout, /prefixed with/);

  const out = join(fixture.directory, 'cli-results');
  const run = spawnSync(process.execPath, [RUN, '--store', fixture.path, '--workflow-id', fixture.workflowId,
    '--mode', 'deterministic', '--out', out, '--pair-id', 'cli-pair'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /单一 Skill 配对评测/);
  const result = JSON.parse(readFileSync(join(out, 'cli-pair', 'result.json'), 'utf8'));
  assert.equal(result.pair.effect, 'on_only');
  assert.ok(existsSync(join(out, 'cli-pair', 'report.md')));
});

function simpleScenario(files) {
  return {
    files,
    positive: { id: 'p', prompt: 'p', checks: [{ type: 'file-equals', path: 'answer.txt', value: '42' }] },
    negative: { id: 'n', prompt: 'n', checks: [{ type: 'file-equals', path: 'answer.txt', value: '42' }],
      forbidden: { files: [], markers: ['rel-'] } }
  };
}

test('grades assistant output separately from the retained client transcript', async t => {
  const fixture = fixtureStore(t);
  const selection = readStoredWorkflow(fixture.path, fixture.workflowId);
  const scenario = simpleScenario({});
  scenario.negative.checks.push({ type: 'output-excludes', values: ['rel-'] });
  for (const [id, answerText, expectedPass] of [['clean', '42', true], ['affected', 'rel-42', false]]) {
    const client = { identity: { name: 'recorded-events', live: true, evidenceKind: 'live_client' },
      run: async () => ({ stdout: 'skill event: rel-example', stderr: 'diagnostic: rel-example', answerText,
        exitCode: 0, timedOut: false, artifacts: { files: { 'answer.txt': '42' } }, evidence: { skillRead: true } }) };
    const result = await evaluateSelectedWorkflow({ selection, out: join(fixture.directory, 'results'),
      pairId: id, client, scenario: validateScenario(scenario) });
    assert.equal(result.negativeControl.skillRead, true);
    assert.equal(result.negativeControl.pass, expectedPass);
    assert.equal(result.negativeControl.triggered, !expectedPass);
    assert.match(result.arms.negativeOn.output.stdout, /rel-example/);
    assert.match(result.arms.negativeOn.output.stderr, /rel-example/);
  }
});

test('--pair-id is one portable directory name and a retry cannot replace evidence', t => {
  const fixture = fixtureStore(t);
  const out = join(fixture.directory, 'pair-ids');
  for (const id of ['../escape', 'nested/pair', 'nested\\pair', '.hidden', 'pair.', 'con', 'bad id']) {
    const run = spawnSync(process.execPath, [RUN, '--store', fixture.path, '--workflow-id', fixture.workflowId,
      '--mode', 'deterministic', '--out', out, '--pair-id', id], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 1, `--pair-id ${id} should be refused`);
    assert.match(run.stderr, /Invalid --pair-id/);
  }
  assert.equal(existsSync(out), false, 'an invalid pair id creates no output directory');

  const args = [RUN, '--store', fixture.path, '--workflow-id', fixture.workflowId, '--mode', 'deterministic',
    '--out', out, '--pair-id', 'pair-1'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(first.status, 0, first.stderr);
  const before = readFileSync(join(out, 'pair-1', 'result.json'));
  const second = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
  assert.deepEqual(readFileSync(join(out, 'pair-1', 'result.json')), before,
    'the earlier report and evidence are untouched');

  assert.equal(safeRunDirectoryName('pair-1.2_a'), 'pair-1.2_a');
  for (const id of ['', '.', '..', 'a/b', 'a\\b', 'C:', 'pair.', 'CON', 'lpt1.txt', ' pair']) {
    assert.throws(() => safeRunDirectoryName(id), /Invalid --pair-id/);
  }
});

test('control filenames are refused case-insensitively for Windows paths only', t => {
  assert.throws(() => validateScenario(simpleScenario({ 'Task.md': 'x' }), { platform: 'win32' }),
    /must not name Task\.md/);
  assert.throws(() => validateScenario(simpleScenario({ 'OPENCODE.JSON': 'x' }), { platform: 'win32' }),
    /must not name/);
  assert.throws(() => validateScenario(simpleScenario({ '.Git/hooks/x': 'x' }), { platform: 'win32' }),
    /must not name/);
  assert.doesNotThrow(() => validateScenario(simpleScenario({ 'Task.md': 'x' }), { platform: 'linux' }));
  assert.throws(() => safeRelativePath('Agents.MD', 'path', { platform: 'win32' }), /must not name/);

  const directory = tempDir(t);
  assert.throws(() => writeArtifactFiles(directory, { 'Task.md': 'x' }, { platform: 'win32' }),
    /must not name/);
  assert.equal(existsSync(join(directory, 'Task.md')), false, 'the refused file is not written');
});

test('the negative control keeps Skill read separate from the output effect', t => {
  const directory = tempDir(t);
  writeFileSync(join(directory, 'answer.txt'), '42\n');
  const observation = observeWorkspace({ directory, baseline: {}, exitCode: 0 });
  const task = validateScenario(simpleScenario({})).negative;
  const read = measureNegativeControl(task, observation, { skillRead: true });
  assert.equal(read.skillRead, true);
  assert.equal(read.triggered, false);
  assert.equal(read.pass, true);
  assert.deepEqual(read.outputEffect.changedPaths, ['answer.txt']);
  assert.deepEqual(read.outputEffect.markers, []);
  const unread = measureNegativeControl(task, observation, { skillRead: false });
  assert.equal(unread.skillRead, false);
  assert.equal(unread.pass, true, 'the output verdict does not depend on whether the Skill was read');
});

test('the event summarizer reports usage and keeps requested and reported models distinct', () => {
  const on = evidenceFor([
    event('tool_use', { id: 'call-1', tool: 'skill', state: { status: 'completed', input: { id: 'release-tag-convention' } } }),
    event('text', { type: 'text', text: '{"files":{"release.txt":"rel-1.4.0"}}' }),
    event('step_finish', { type: 'step-finish', tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 4 } },
      providerID: 'synthetic', modelID: 'model-v2' })
  ], { selection: { workflowId: 'workflow-synthetic' }, selectedSkill: 'release-tag-convention', model: 'synthetic/model' });
  assert.deepEqual(on.tokens, { source: 'client-reported', steps: 1, input: 11, output: 7,
    reasoning: 2, cacheRead: 3, cacheWrite: 4 });
  assert.equal(on.requestedModel, 'synthetic/model');
  assert.equal(on.reportedModel, 'synthetic/model-v2');
  assert.equal(on.reportedModelSource, 'step_events');
  assert.equal(on.upstreamExecution, 'confirmed');
  assert.equal(on.skillRead, true);
  assert.equal(on.skillReadExpected, true);
  assert.equal(on.skillCallStatus, 'completed');
});

test('the report renders duration and client-reported tokens, and keeps requested and reported models distinct', () => {
  const on = evidenceFor([
    event('tool_use', { id: 'call-1', tool: 'skill', state: { status: 'completed', input: { id: 'release-tag-convention' } } }),
    event('step_finish', { type: 'step-finish', tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 4 } },
      providerID: 'synthetic', modelID: 'model-v2' })
  ], { selection: { workflowId: 'workflow-synthetic' }, selectedSkill: 'release-tag-convention', model: 'synthetic/model' });
  const off = evidenceFor([
    event('step_finish', { type: 'step-finish', tokens: { input: 5, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } })
  ], { model: 'synthetic/model' });
  const negative = evidenceFor([
    event('step_finish', { type: 'step-finish', tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
  ], { selection: { workflowId: 'workflow-synthetic' }, selectedSkill: 'release-tag-convention', model: 'synthetic/model' });
  const result = reportResult({
    positiveOff: armRecord('positive-off', { pass: false, evidence: off, durationMs: 1234, changedPaths: ['release.txt'] }),
    positiveOn: armRecord('positive-on', { pass: true, evidence: on, durationMs: 567, changedPaths: ['release.txt'] }),
    negativeOn: armRecord('negative-on', { pass: true, evidence: negative, durationMs: 890, changedPaths: ['answer.txt'] }),
    negativeControl: { measured: true, skillRead: false, triggered: false, triggeredBy: { files: [], markers: [] },
      outputEffect: { changedPaths: ['answer.txt'], newFiles: ['answer.txt'], markers: [] }, pass: true }
  });
  const report = renderReport(result);
  assert.match(report, /## 两臂耗时与 token/u);
  assert.match(report, /\| positive-off \| 1\.2s \| 5 \| 4 \| 0 \| 0 \| 0 \| 客户端报告 \|/u);
  assert.match(report, /\| positive-on \| 0\.6s \| 11 \| 7 \| 2 \| 3 \| 4 \| 客户端报告 \|/u);
  assert.ok(report.includes('`synthetic/model-v2`'), 'the report names the model the client reported');
  assert.match(report, /Skill 读取：否/u);
});

test('a client error without a finished step is not reported as confirmed upstream execution', () => {
  const errorEvidence = evidenceFor([
    event('error', {}, { error: { type: 'provider.no-route', message: 'Model unavailable: synthetic/model' } })
  ], { selection: { workflowId: 'workflow-synthetic' }, selectedSkill: 'release-tag-convention', model: 'synthetic/model' });
  assert.equal(errorEvidence.providerContact, true);
  assert.equal(errorEvidence.upstreamExecution, 'not_confirmed');
  assert.deepEqual(errorEvidence.tokens, { source: 'unknown', steps: 0, input: null, output: null,
    reasoning: null, cacheRead: null, cacheWrite: null,
    unavailable: 'The client reported no step_finish token events for this arm.' });
  assert.equal(errorEvidence.reportedModel, null);
  assert.equal(errorEvidence.reportedModelSource, 'unknown');
  const arm = armRecord('positive-on', { pass: null, evidence: errorEvidence, durationMs: 321 });
  const result = reportResult({
    positiveOff: armRecord('positive-off', { pass: null, evidence: errorEvidence, durationMs: 320 }),
    positiveOn: arm,
    negativeOn: null,
    negativeControl: { measured: false, skillRead: null, triggered: null, pass: null,
      unavailable: 'The client returned no finished model step.' }
  });
  const report = renderReport(result);
  assert.match(report, /不能确认提供方实际执行/u);
  assert.match(report, /客户端步骤事件报告：未报告（未知）/u);
  assert.doesNotMatch(report, /已联系模型提供方/u);
});

test('the installed package exposes only the paired evaluator, with consistent shrinkwrap metadata', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const shrinkwrap = JSON.parse(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'));

  assert.equal(manifest.bin['fuli-skill-eval'], 'acceptance/skill-paired-eval/run.js');
  assert.match(readFileSync(join(root, manifest.bin['fuli-skill-eval']), 'utf8'), /^#!\/usr\/bin\/env node\n/u);
  assert.ok(manifest.files.includes('acceptance/skill-paired-eval/'));
  const acceptance = manifest.files.filter(path => path.startsWith('acceptance/'));
  assert.deepEqual(acceptance, ['acceptance/skill-paired-eval/'],
    'only the paired evaluator enters the package, never other acceptance data');
  assert.ok(manifest.files.includes('src/'));

  const metadata = shrinkwrap.packages[''];
  assert.equal(shrinkwrap.name, manifest.name);
  assert.equal(shrinkwrap.version, manifest.version);
  assert.equal(metadata.name, manifest.name);
  assert.equal(metadata.version, manifest.version);
  assert.deepEqual(metadata.bin, manifest.bin,
    'shrinkwrap root bin stays consistent with package.json');

  const readme = readFileSync(join(root, 'acceptance/skill-paired-eval/README.md'), 'utf8');
  const recipe = readFileSync(join(root, 'skills/operating-fuli/references/workflow-recipes.md'), 'utf8');
  assert.match(readme, /fuli-skill-eval/u);
  assert.match(recipe, /fuli-skill-eval/u);
  assert.match(recipe, /npm run measure:skill-paired/u, 'the source script is still documented');
});
