// rec#5 C2 and C5: which projects FULI records, and what every receipt says when a
// turn is not recorded. Synthetic fixtures only: temporary directories stand in for
// the user's repositories and a recording double stands in for the Provider. No FULI
// data directory, live Provider, port-2727 service or client configuration is used.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { runCursorLifecycleHook } from '../src/agents/cursor/lifecycle-hook.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { syncConversationTranscript } from '../src/conversations/sync-transcript.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';

const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-person', spaceId: 'synthetic-space' } };
const CODEX_TRANSCRIPT = { normalize: normalizeCodexRecord, verify: verifyCodexTranscript };
// Words from a turn the user chose not to record. No receipt, store or message may keep them.
const PRIVATE = 'synthetic-private-words';
// Every notice also says that what the person submits explicitly still saves (rec#11 D-01).
const PROJECT_OFF = '此项目未开启记忆；你明确提交的修改仍会保存';
const UNREGISTERED = '当前目录不是 FULI 项目，未自动记录；你明确提交的修改仍会保存';
const REGISTERED = ['thesis', 'family-ledger', 'job-hunt', 'novel'];

async function fixture(t, { registered = REGISTERED } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-capture-projects-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const dirs = {};
  // side-repo is a repository the user never registered.
  for (const id of [...REGISTERED, 'side-repo']) {
    dirs[id] = join(root, 'repos', id);
    await mkdir(join(dirs[id], '.git'), { recursive: true });
  }
  // A second working tree of thesis in an unrelated folder, as `git worktree add` makes it.
  const worktreeGit = join(dirs.thesis, '.git', 'worktrees', 'chapter-3');
  dirs.thesisWorktree = join(root, 'elsewhere', 'chapter-3');
  await mkdir(worktreeGit, { recursive: true });
  await mkdir(dirs.thesisWorktree, { recursive: true });
  await writeFile(join(dirs.thesisWorktree, '.git'), `gitdir: ${worktreeGit}\n`);
  dirs.downloads = join(root, 'Downloads');
  await mkdir(dirs.downloads);

  const runtimeConfigPath = join(root, 'runtime', 'graph-runtime.json');
  await mkdir(join(root, 'runtime'));
  const clock = { now: '2026-10-20T08:00:00.000Z' };
  const store = new CapturePolicyStore(capturePolicyPathForRuntime(runtimeConfigPath), { now: () => clock.now });
  const projects = new Set(registered);
  const writes = [];
  const knowledge = [];
  const app = new FederatedGraphApplication(CONFIG, { capturePolicyStore: store,
    taskContextRegistry: new TaskContextRegistry(),
    fetchImpl: async url => { throw new Error(`Unexpected Provider request ${new URL(url).pathname}`); } });
  app.upsertPersonalProject = async input => {
    writes.push({ kind: 'project', project: input.projectId });
    projects.add(input.projectId);
    return projectRecord(input.projectId);
  };
  Object.assign(app.personal, {
    listPersonalProjects: async () => [...projects].map(projectRecord),
    getPersonalProject: async (_space, id) => {
      if (!projects.has(id)) throw Object.assign(new Error('Not found'), { status: 404 });
      return projectRecord(id);
    },
    listProjectAgentAssignments: async () => [],
    resolveProjectAgentContext: async input => ({ status: 'ready', agent: lead(input.personal_project_id) }),
    getProjectAgent: async (_space, project) => lead(project),
    collaborationPreferences: async (space, project, _limit, agent) => ({ personal_space_id: space,
      personal_project_id: project, project_agent_id: agent, effective_preferences: [], global_preferences: [], conflicts: [] }),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({}),
    listProjectAgents: async () => [],
    listProjectAgentTasks: async () => [],
    recordAgentViews: async () => ({ status: 'recorded' }),
    conversation: async (operation, input) => {
      if (operation === 'query') return input.mode === 'policy' ? { enabled: true } : { cursor: 0, initialized: true };
      writes.push({ kind: 'conversation', operation, project: input.personal_project_id ?? null });
      return { status: 'saved', conversation_id: `conversation-${writes.length}` };
    },
    preflightCommits: async commits => ({ status: 'validated', count: commits.length }),
    commit: async commit => {
      writes.push({ kind: 'knowledge', project: commit.personal_project_id });
      knowledge.push(commit);
      return { status: 'committed', episode_id: `episode-${knowledge.length}`,
        entity_ids: commit.episode.entities.map(entity => `entity-${knowledge.length}-${entity.key}`), relationship_ids: [] };
    }
  });
  app.searchKnowledge = async () => ({ facts: knowledge.map(commit => ({ episode: commit.episode.name,
    personal_project_id: commit.personal_project_id })), entities: [] });
  return { root, dirs, app, store, clock, projects, writes, knowledge, runtimeConfigPath,
    captureWrites: () => writes.filter(write => write.kind !== 'project') };
}

function projectRecord(id) {
  return { project_id: id, scope_type: 'registered', profile: { name: id } };
}

function lead(project) {
  return { agent_id: `lead-${project ?? 'global'}`, personal_space_id: 'synthetic-space', personal_project_id: project,
    memory_scope: 'reviewed_agent', profile: { name: `Lead ${project ?? 'global'}`, status: 'active',
      allowed_clients: ['codex', 'claude_code', 'cursor'], work_kinds: ['project_context'], capabilities: [] } };
}

const leases = () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} });

// A Codex prompt through its real lifecycle hook and the real begin_task_context tool.
async function codexEntry(f, cwd, { session = 'synthetic-codex-session', prompt = `Plan ${PRIVATE}.`,
  transcriptPath = undefined } = {}) {
  let context;
  const output = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => ({ session_id: session, cwd, prompt, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }),
    write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases,
    callTool: async (app, name, input, request) => {
      const result = await callAgentTool(app, name, input, request);
      if (name === 'begin_task_context') context = result;
      return result;
    }
  });
  return { output, context };
}

async function claudeEntry(f, cwd, { session = 'synthetic-claude-session', prompt = `Plan ${PRIVATE}.` } = {}) {
  let context;
  const output = await runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => ({ session_id: session, cwd, prompt }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases,
    callTool: async (app, name, input, request) => {
      const result = await callAgentTool(app, name, input, request);
      if (name === 'begin_task_context') context = result;
      return result;
    }
  });
  return { output, context };
}

// Cursor's hook starts the task; its Agent then reads the receipt from
// get_collaboration_preferences, as the sessionStart guidance tells it to.
async function cursorEntry(f, cwd, { session = 'synthetic-cursor-session', prompt = `Plan ${PRIVATE}.` } = {}) {
  const output = await runCursorLifecycleHook(['--event', 'beforeSubmitPrompt'], {
    readInput: async () => ({ conversation_id: session, workspace_roots: [cwd], prompt }), write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases
  });
  const context = await callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: cwd, taskPrompt: prompt,
    sessionId: session, sourceApplication: 'cursor', sourceSessionId: session });
  return { output, context };
}

// The finishing checkpoint of a task: a global preference, and a project fact
// when the task has a project.
function finishTask(f, context, sourceApplication = 'codex') {
  return callAgentTool(f.app, 'checkpoint_task_knowledge', { taskContextToken: context.taskContextToken,
    sourceApplication, disposition: 'capture_candidates', reason: `Finished ${PRIVATE}.`,
    workLog: { status: 'completed', summary: `Did ${PRIVATE}.` },
    remember: [{ kind: 'preference', text: `Prefers ${PRIVATE}.`, quote: `I prefer ${PRIVATE}.` },
      ...(context.context.personal_project_id ? [{ kind: 'project_fact', text: `The ${PRIVATE} draft is due Friday.` }] : [])] });
}

const receiptOf = context => context.agent_receipt.markdown;
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
  const updated = await callAgentTool(f.app, 'update_capture_policy', { projectMode: 'all_except',
    excludedProjectIds: ['family-ledger'] });
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
  assert.deepEqual((await callAgentTool(f.app, 'update_capture_policy', { excludedProjectIds: [] })).projectsOffSince, {});
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
  assert.deepEqual(f.captureWrites(), []);
  taskProject = 'novel';
  await syncConversationTranscript(f.app, input, 'codex', CODEX_TRANSCRIPT);
  assert.deepEqual(f.captureWrites().map(write => [write.kind, write.project]), [['conversation', 'novel']]);
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

test('C4-5 Claude Code, Codex and Cursor say the same thing and record nothing', async (t) => {
  const f = await fixture(t);
  f.store.update({ projectMode: 'all_except', excludedProjectIds: ['job-hunt'] });
  const entries = { claude_code: await claudeEntry(f, f.dirs['job-hunt']), codex: await codexEntry(f, f.dirs['job-hunt']),
    cursor: await cursorEntry(f, f.dirs['job-hunt']) };
  const notices = Object.entries(entries).map(([client, entry]) => [client, receiptOf(entry.context).split(' · ').at(-1)]);
  assert.deepEqual(notices, ['claude_code', 'codex', 'cursor'].map(client => [client, PROJECT_OFF]));
  // The two hooks that can show a message say it at entry too.
  for (const client of ['claude_code', 'codex']) {
    assert.ok(entries[client].output.systemMessage.includes(PROJECT_OFF), client);
  }
  for (const [client, entry] of Object.entries(entries)) await finishTask(f, entry.context, client);
  assert.deepEqual(f.captureWrites(), []);
});

test('every reason that stops a turn has its one notice', async (t) => {
  for (const [name, setUp, notice] of [
    ['global_off', f => f.store.update({ enabled: false }), '自动记录已关闭；你明确提交的修改仍会保存'],
    ['client_off', f => f.store.update({ disabledSources: ['codex'] }), '自动记录已关闭；你明确提交的修改仍会保存'],
    ['policy_unavailable', f => writeFile(capturePolicyPathForRuntime(f.runtimeConfigPath), '{ not json'),
      '记录设置读取失败，本次未自动记录；你明确提交的修改仍会保存']
  ]) {
    const f = await fixture(t);
    await setUp(f);
    const entry = await codexEntry(f, f.dirs.novel);
    assert.ok(receiptOf(entry.context).endsWith(` · ${notice}`), `${name}: ${receiptOf(entry.context)}`);
  }
});

test('the Agent can read and change project modes, and is told to confirm first', async (t) => {
  const f = await fixture(t);
  const update = listAgentTools().find(tool => tool.name === 'update_capture_policy');
  assert.match(update.description, /restate/i);
  assert.match(update.description, /confirm/i);
  assert.deepEqual(Object.keys(update.inputSchema.properties).sort(), ['disabledSources', 'enabled',
    'excludedProjectIds', 'projectMode', 'selectedProjectIds', 'unregisteredDirectories']);
  assert.equal(update.inputSchema.required, undefined, 'a project change does not resend the global switch');
  const read = listAgentTools().find(tool => tool.name === 'get_capture_policy');
  assert.ok(read.inputSchema.properties.projectPath);

  f.store.update({ enabled: false });
  const changed = await callAgentTool(f.app, 'update_capture_policy', { projectMode: 'selected', selectedProjectIds: ['thesis'] });
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
  await callAgentTool(f.app, 'get_capture_policy', { projectPath: f.dirs.thesis, sourceApplication: 'codex' });
  await syncConversationTranscript(f.app, { session_id: 'synthetic-session', cwd: f.dirs.downloads,
    transcript_path: transcript }, 'codex', CODEX_TRANSCRIPT);
  assert.deepEqual(lookups, [], 'all projects and all folders are recorded, so no decision needs the project');
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
