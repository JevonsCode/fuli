// rec#5 C2 and C5: which projects FULI records, and what every receipt says when a
// turn is not recorded. Synthetic fixtures only: temporary directories stand in for
// the user's repositories and a recording double stands in for the Provider. No FULI
// data directory, live Provider, port-2727 service or client configuration is used.
import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { syncConversationTranscript } from '../src/conversations/sync-transcript.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { codexEntry, codexStop, confirmedCaptureChange, finishTask, fixture, PRIVATE, receiptOf,
  transcriptRow } from './fixtures/capture-project-fixture.js';

const CODEX_TRANSCRIPT = { normalize: normalizeCodexRecord, verify: verifyCodexTranscript };
// Every notice also says that what the person submits explicitly still saves (rec#11 D-01).
const PROJECT_OFF = '此项目未开启记忆；你明确提交的修改仍会保存';
const UNREGISTERED = '当前目录不是 FULI 项目，未自动记录；你明确提交的修改仍会保存';

const captureShape = value => ({ status: value?.status, reason: value?.reason, layer: value?.layer });

test('C2-1 selected mode records only the chosen project and tells the other one why', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'selected', selectedProjectIds: ['thesis'] });

  const thesis = await codexEntry(f, f.dirs.thesis);
  assert.equal(thesis.context.context.personal_project_id, 'thesis');
  assert.doesNotMatch(receiptOf(thesis.context), /未开启记忆|未自动记录|自动记录已关闭/, 'a recorded turn adds nothing');
  const thesisCheckpoint = await finishTask(f, thesis.context);
  assert.deepEqual(thesisCheckpoint.capture_results.map(result => [result.scope, result.status]),
    [['current_project', 'committed'], ['personal_global', 'committed']],
    'a global preference learned in a recorded project is recorded too');
  assert.ok(f.captureWrites().length >= 2);

  const before = f.captureWrites().length;
  const ledger = await codexEntry(f, f.dirs['family-ledger']);
  assert.equal(ledger.context.context.personal_project_id, 'family-ledger');
  assert.ok(receiptOf(ledger.context).endsWith(` · ${PROJECT_OFF}`), receiptOf(ledger.context));
  assert.ok(ledger.output.hookSpecificOutput.additionalContext.includes(PROJECT_OFF), 'the hook delivers the notice');
  const ledgerCheckpoint = await finishTask(f, ledger.context);
  assert.equal(ledgerCheckpoint.status, 'checkpointed');
  assert.equal(ledgerCheckpoint.capture_status, 'capture_disabled');
  assert.ok(receiptOf(ledgerCheckpoint).endsWith(` · ${PROJECT_OFF}`), 'the checkpoint receipt says it too');
  assert.deepEqual(f.captureWrites().slice(before), [], 'nothing from family-ledger was written');
});

test('C2-2 all_except skips the excluded project only, and both keep reading existing knowledge', async (t) => {
  const f = await fixture(t);
  await finishTask(f, (await codexEntry(f, f.dirs['job-hunt'])).context);
  const history = f.knowledge.length;
  f.store.update({ projectMode: 'all_except', excludedProjectIds: ['job-hunt'] });

  const before = f.captureWrites().length;
  const jobs = await codexEntry(f, f.dirs['job-hunt']);
  assert.ok(receiptOf(jobs.context).endsWith(` · ${PROJECT_OFF}`));
  await finishTask(f, jobs.context);
  assert.deepEqual(f.captureWrites().slice(before), [], 'not one job-hunt record is written');

  const novel = await codexEntry(f, f.dirs.novel);
  assert.doesNotMatch(receiptOf(novel.context), /未开启记忆/);
  await finishTask(f, novel.context);
  assert.ok(f.captureWrites().slice(before).length > 0 && f.captureWrites().slice(before).every(write =>
    write.project === 'novel' || write.project === null), 'only the novel is recorded');

  for (const project of ['job-hunt', 'novel']) {
    const found = await callAgentTool(f.app, 'search_knowledge_graph', { personalSpaceId: 'synthetic-space',
      personalProjectId: project, query: 'draft' });
    assert.ok(found.facts.length >= history, `${project} still reads existing knowledge`);
  }
});

test('C2-3 an unregistered directory is not recorded quietly under selected mode', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'selected', selectedProjectIds: ['thesis'] });
  for (const cwd of [f.dirs.downloads, f.dirs['side-repo']]) {
    const before = f.writes.length;
    const entry = await codexEntry(f, cwd);
    assert.equal(entry.context.context.personal_project_id, null);
    assert.ok(receiptOf(entry.context).endsWith(` · ${UNREGISTERED}`), receiptOf(entry.context));
    const checkpoint = await finishTask(f, entry.context);
    assert.deepEqual([checkpoint.status, checkpoint.capture_status], ['checkpointed', 'capture_disabled']);
    assert.ok(receiptOf(checkpoint).endsWith(` · ${UNREGISTERED}`));
    assert.deepEqual(f.writes.slice(before), [], 'no record, and no project registered for the folder');
  }
  assert.equal(f.projects.has('side-repo'), false);
});

test('C2-4 switching a project off keeps its history and records since when', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index += 1) {
    await finishTask(f, (await codexEntry(f, f.dirs['family-ledger'], { prompt: `Entry ${index} ${PRIVATE}.` })).context);
  }
  const history = f.knowledge.filter(commit => commit.personal_project_id === 'family-ledger').length;
  assert.ok(history >= 2);

  f.clock.now = '2026-10-20T09:30:00.000Z';
  const updated = await confirmedCaptureChange(f, { projectMode: 'all_except', excludedProjectIds: ['family-ledger'] });
  assert.deepEqual(updated.projectsOffSince, { 'family-ledger': '2026-10-20T09:30:00.000Z' });
  assert.equal(f.knowledge.filter(commit => commit.personal_project_id === 'family-ledger').length, history,
    'nothing already recorded is removed');
  const found = await callAgentTool(f.app, 'search_knowledge_graph', { personalSpaceId: 'synthetic-space',
    personalProjectId: 'family-ledger', query: 'draft' });
  assert.ok(found.facts.length >= history, 'and it stays searchable');

  const policy = await callAgentTool(f.app, 'get_capture_policy', { projectPath: f.dirs['family-ledger'],
    sourceApplication: 'codex' });
  assert.equal(policy.projectMode, 'all_except');
  assert.deepEqual(policy.excludedProjectIds, ['family-ledger']);
  assert.deepEqual(policy.current, { sourceApplication: 'codex', personalProjectId: 'family-ledger', captured: false,
    reason: 'project_off', layer: 'project', offSince: '2026-10-20T09:30:00.000Z', notice: PROJECT_OFF });
  const novel = await callAgentTool(f.app, 'get_capture_policy', { projectPath: f.dirs.novel, sourceApplication: 'codex' });
  assert.deepEqual([novel.current.personalProjectId, novel.current.captured, novel.current.notice], ['novel', true, null]);

  // Back on: new work is recorded again and the switch-off time is gone.
  f.clock.now = '2026-10-21T09:30:00.000Z';
  assert.deepEqual((await confirmedCaptureChange(f, { excludedProjectIds: [] })).projectsOffSince, {});
});

test('C2-5 a worktree of a project is that project, wherever it lives', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'selected', selectedProjectIds: ['thesis'] });
  const recorded = await codexEntry(f, f.dirs.thesisWorktree);
  assert.equal(recorded.context.context.personal_project_id, 'thesis');
  assert.doesNotMatch(receiptOf(recorded.context), /未开启记忆|未自动记录/);
  const before = f.captureWrites().length;
  await finishTask(f, recorded.context);
  assert.ok(f.captureWrites().length > before);
  assert.deepEqual(await captureDecision(f.app, { sourceApplication: 'codex', projectPath: f.dirs.thesisWorktree }),
    { allowed: true, reason: null, layer: null });

  f.store.update({ projectMode: 'all_except', excludedProjectIds: ['thesis'] });
  assert.deepEqual(await captureDecision(f.app, { sourceApplication: 'codex', projectPath: f.dirs.thesisWorktree }),
    { allowed: false, reason: 'project_off', layer: 'project' });
});

test('C1-4 under selected mode an older adapter that names only its client records nothing', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'selected', selectedProjectIds: ['thesis'] });
  const expected = { allowed: false, reason: 'project_unregistered', layer: 'project' };
  assert.deepEqual(await captureDecision(f.app, { sourceApplication: 'codex' }), expected);
  const knowledge = await callAgentTool(f.app, 'capture_session_knowledge', { targetKind: 'personal',
    spaceId: 'synthetic-space', sourceApplication: 'codex', idempotencyKey: 'synthetic-old-adapter',
    name: 'Synthetic capture', sourceKind: 'conversation', sourceDescription: 'Synthetic session evidence',
    referenceTime: '2026-10-20T00:00:00.000Z', sensitivity: 'normal',
    entities: [{ key: 'preference:synthetic', name: PRIVATE, type: 'Preference', originQuadrant: 'known_known',
      confirmationStatus: 'pending', confirmationBasis: { existenceReason: 'The user stated it.',
        quadrantReason: 'The user stated it explicitly.', proposedBy: { kind: 'agent', label: 'Codex' } } }],
    relationships: [] });
  assert.deepEqual(captureShape(knowledge), { status: 'capture_disabled', reason: 'project_unregistered', layer: 'project' });

  // A hook that does not report its directory cannot show it is outside a project,
  // so its transcript is not imported even when unregistered directories are captured.
  f.store.update({ unregisteredDirectories: 'capture' });
  const transcript = join(f.root, 'session.jsonl');
  await writeFile(transcript, '');
  assert.deepEqual(captureShape(await syncConversationTranscript(f.app, { session_id: 'synthetic-old-session',
    transcript_path: transcript }, 'codex', CODEX_TRANSCRIPT)),
  { status: 'capture_disabled', reason: 'project_unregistered', layer: 'project' });
  assert.deepEqual(f.captureWrites(), []);
});

test('a transcript is not imported into a switched-off project from an unregistered folder', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'all_except', excludedProjectIds: ['job-hunt'] });
  const transcript = join(f.root, 'session.jsonl');
  await writeFile(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session' } })}\n`
    + `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: PRIVATE }] } })}\n`);
  let taskProject = 'job-hunt';
  f.app.personal.currentTaskContext = async () => ({ token: 'fuli-task-synthetic', project_agent_id: `lead-${taskProject}`,
    personal_project_id: taskProject });
  const input = { session_id: 'synthetic-session', cwd: f.dirs.downloads, transcript_path: transcript };
  // A handoff pending for that task is dropped with it: nothing of it is ever imported.
  const guard = { value: { version: 1, phase: 'scan', scanCursor: 0 }, clear: async () => { guard.value = null; } };
  assert.deepEqual(captureShape(await syncConversationTranscript(f.app, input, 'codex', CODEX_TRANSCRIPT, guard)),
    { status: 'capture_disabled', reason: 'project_off', layer: 'project' });
  assert.equal(guard.value, null);
  // Only a content-free marker moves that conversation past what was not recorded (rec#11).
  assert.deepEqual(f.captureWrites().map(write => [write.project, write.content.includes(PRIVATE),
    write.content.startsWith('[Not recorded: automatic recording was off (project_off)')]), [['job-hunt', false, true]]);
  taskProject = 'novel';
  await syncConversationTranscript(f.app, input, 'codex', CODEX_TRANSCRIPT);
  assert.deepEqual(f.captureWrites().slice(1).map(write => [write.kind, write.project, write.content.includes(PRIVATE)]),
    [['conversation', 'novel', true]]);
});

test('a project deleted while listed has no effect, and registering it again restores its setting', async (t) => {
  const f = await fixture(t, { registered: ['family-ledger', 'novel'] });
  f.store.update({ projectMode: 'selected', selectedProjectIds: ['thesis', 'novel'] });
  const missing = await codexEntry(f, f.dirs.thesis);
  assert.ok(receiptOf(missing.context).endsWith(` · ${UNREGISTERED}`), 'unregistered while deleted, without an error');
  assert.equal(f.projects.has('thesis'), false, 'a skipped folder is not registered automatically');
  assert.deepEqual(f.store.read().selectedProjectIds, ['novel', 'thesis']);

  f.projects.add('thesis');
  const restored = await codexEntry(f, f.dirs.thesis, { session: 'synthetic-codex-session-2' });
  assert.equal(restored.context.context.personal_project_id, 'thesis');
  assert.doesNotMatch(receiptOf(restored.context), /未开启记忆|未自动记录/);
});

test('C5-1 C5-2 the notice is on every turn and carries none of the turn', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'all_except', excludedProjectIds: ['job-hunt'] });
  for (let turn = 0; turn < 3; turn += 1) {
    const entry = await codexEntry(f, f.dirs['job-hunt'], { prompt: `Turn ${turn}: ${PRIVATE}.` });
    assert.ok(receiptOf(entry.context).endsWith(` · ${PROJECT_OFF}`), `turn ${turn}`);
    const checkpoint = await finishTask(f, entry.context);
    for (const visible of [entry.context.agent_receipt, entry.output.systemMessage ?? '', checkpoint.agent_receipt,
      checkpoint.capture]) {
      assert.equal(JSON.stringify(visible).includes(PRIVATE), false, 'no words from the unrecorded turn');
    }
  }
  assert.deepEqual(f.captureWrites(), []);
});

test('the Agent can read and ask to change project modes; the person confirms in the console', async (t) => {
  const f = await fixture(t);
  const update = listAgentTools().find(tool => tool.name === 'update_capture_policy');
  assert.match(update.description, /never saved by this tool/);
  assert.match(update.description, /confirm or cancel in the FULI console/);
  assert.deepEqual(Object.keys(update.inputSchema.properties).sort(), ['disabledSources', 'enabled',
    'excludedProjectIds', 'projectMode', 'recordProjects', 'selectedProjectIds', 'sessionPaused',
    'taskContextToken', 'unregisteredDirectories']);
  assert.equal(update.inputSchema.required, undefined, 'a project change does not resend the global switch');
  const read = listAgentTools().find(tool => tool.name === 'get_capture_policy');
  assert.ok(read.inputSchema.properties.projectPath);

  f.store.update({ enabled: false });
  const changed = await confirmedCaptureChange(f, { projectMode: 'selected', selectedProjectIds: ['thesis'] });
  assert.equal(changed.enabled, false, 'changing projects never turns recording back on');
  const policy = await callAgentTool(f.app, 'get_capture_policy', { projectPath: f.dirs.thesis, sourceApplication: 'codex' });
  assert.deepEqual([policy.current.captured, policy.current.reason, policy.current.notice],
    [false, 'global_off', '自动记录已关闭；你明确提交的修改仍会保存']);
});

test('the settings page API reads and changes project modes', async (t) => {
  const f = await fixture(t);
  const call = async (method, body) => {
    let sent;
    const request = { method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    const response = { writeHead: (status) => { sent = { status }; }, setHeader: () => {}, end: text => { sent.body = JSON.parse(text); } };
    await handleGraphApiRequest({ request, response, url: new URL('http://127.0.0.1/api/capture-policy'), app: f.app });
    return sent;
  };
  const patched = await call('PATCH', { projectMode: 'all_except', excludedProjectIds: ['job-hunt'] });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.body.projectMode, patched.body.excludedProjectIds], ['all_except', ['job-hunt']]);
  const read = await call('GET');
  assert.deepEqual(read.body.projectsOffSince, { 'job-hunt': '2026-10-20T08:00:00.000Z' });
});

// Counts how often capture decisions look a directory up.
function countLookups(f) {
  const lookups = [];
  const resolve = f.app.resolveProjectPath.bind(f.app);
  f.app.resolveProjectPath = projectPath => { lookups.push(projectPath); return resolve(projectPath); };
  return lookups;
}

test('the default mode decides without looking up any project', async (t) => {
  const f = await fixture(t);
  const lookups = countLookups(f);
  const transcript = join(f.root, 'session.jsonl');
  await writeFile(transcript, '');
  f.app.personal.currentTaskContext = async () => null;
  const entry = await codexEntry(f, f.dirs['side-repo'], { transcriptPath: transcript });
  await finishTask(f, entry.context);
  await syncConversationTranscript(f.app, { session_id: 'synthetic-session', cwd: f.dirs.downloads,
    transcript_path: transcript }, 'codex', CODEX_TRANSCRIPT);
  assert.deepEqual(lookups, [], 'all projects and all folders are recorded, so no decision needs the project');
  // Asked which project this is, so "这个项目以后别记了" can name it (C4-2), the read looks once.
  const policy = await callAgentTool(f.app, 'get_capture_policy', { projectPath: f.dirs.thesis, sourceApplication: 'codex' });
  assert.equal(policy.current.personalProjectId, 'thesis');
  assert.deepEqual(lookups, [f.dirs.thesis]);
});

test('under a project mode one hook run or tool request looks its directory up once', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'all_except', excludedProjectIds: ['job-hunt'] });
  const lookups = countLookups(f);
  const transcript = join(f.root, 'session.jsonl');
  await writeFile(transcript, '');
  let taskLookups = 0;
  f.app.personal.currentTaskContext = async () => { taskLookups += 1; return null; };
  // An unregistered repository: the entry, its transcript sync and claim, the
  // registration check and the view records all ask about the same directory.
  await codexEntry(f, f.dirs['side-repo'], { transcriptPath: transcript });
  assert.deepEqual(lookups, [f.dirs['side-repo']]);
  assert.ok(taskLookups > 0, 'decisions inside the capture window resolve the directory as well');

  lookups.length = 0;
  await callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: f.dirs.novel, taskPrompt: 'Plan.',
    sessionId: 'synthetic-cursor-session', sourceApplication: 'cursor', sourceSessionId: 'synthetic-cursor-session' });
  assert.ok(lookups.length <= 1, `one request, ${lookups.length} lookups`);
});


test('turns written while a project was off are never imported after it is switched back on', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'all_except', excludedProjectIds: [] });
  const transcript = join(f.root, 'session.jsonl');
  await writeFile(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session' } })}
`);
  f.app.personal.currentTaskContext = async () => ({ token: 'fuli-task-synthetic', project_agent_id: 'lead-novel',
    personal_project_id: 'novel' });
  const input = { session_id: 'synthetic-session', cwd: f.dirs.novel, transcript_path: transcript };
  const imported = () => f.captureWrites().filter(write => write.kind === 'conversation').map(write => write.content).join(' | ');
  await codexStop(f, input);
  await appendFile(transcript, transcriptRow('turn-before'));
  await codexStop(f, input);
  assert.match(imported(), /turn-before/, 'the session is recorded while the project is on');

  // The project goes off; the host writes turns, but no hook gets to mark them.
  f.store.update({ excludedProjectIds: ['novel'] });
  await appendFile(transcript, transcriptRow(`turn-while-off ${PRIVATE}`));
  f.store.update({ excludedProjectIds: [] });
  await codexStop(f, input);
  await appendFile(transcript, transcriptRow('turn-after'));
  await codexStop(f, input);

  assert.equal(imported().includes(PRIVATE), false, 'nothing from the off period is imported');
  assert.ok(imported().includes('[Not recorded: capture settings changed, so this stretch could not be confirmed'), imported());
  assert.match(imported(), /turn-after/, 'recording resumes for new turns');
});
