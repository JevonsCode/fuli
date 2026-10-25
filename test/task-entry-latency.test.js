import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { claudeEntryDeadlineOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { runCodexLifecycleCommand, runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { entryBudget, noteEntryNotice, noteEntryTask, partialEntryText, runWithEntryBudget } from '../src/conversations/entry-budget.js';
import { openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { withSharedProjectList } from '../src/graphiti/shared-project-list.js';
import { createToolInputValidator } from '../src/mcp/tool-input-budget.js';

// Task entry latency (rec#39 D-40): parallel Provider reads, and what a hook
// delivers at its deadline. A synthetic data directory and an in-memory
// Provider double with an artificial latency only.

const AGENT = { agent_id: 'project.lead', personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project',
  profile: { name: 'Lead', responsibility: 'Synthetic lead', status: 'active', allowed_clients: ['codex'], capabilities: [] } };

// Every request is logged in event order (start and end are positions in one
// sequence, not times), with the most requests ever in flight at once.
// `hold` keeps one route pending until the request is cancelled. `together`
// pairs requests by route and occurrence ('GET /health#1'): each one is held
// until its partner has started, so requests the entry issues together always
// overlap, and a serial entry never lets the partner start (it fails, after
// PAIR_FALLBACK_MS instead of hanging).
const PAIR_FALLBACK_MS = 3000;

function fakeProvider({ latencyMs, hold = null, together = [] }) {
  const requests = [];
  const seen = new Map();
  const partners = new Map(together.flatMap(([a, b]) => [[a, b], [b, a]]));
  const starts = new Map([...partners.keys()].map(key => [key, Promise.withResolvers()]));
  let events = 0, inFlight = 0;
  const stats = { maxInFlight: 0 };
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const route = `${init.method ?? 'GET'} ${pathname}`;
    seen.set(route, (seen.get(route) ?? 0) + 1);
    const key = `${route}#${seen.get(route)}`;
    const request = { route, key, start: ++events, end: null, body: init.body ? JSON.parse(init.body) : null };
    requests.push(request);
    stats.maxInFlight = Math.max(stats.maxInFlight, ++inFlight);
    try {
      starts.get(key)?.resolve();
      if (partners.has(key)) await Promise.race([starts.get(partners.get(key)).promise, delay(PAIR_FALLBACK_MS, undefined, { ref: false })]);
      await delay(route === hold ? 5000 : latencyMs, undefined, { signal: init.signal });
    } finally { inFlight -= 1; }
    request.end = ++events;
    const body = route === 'GET /v1/personal-projects' ? [{ project_id: 'synthetic-project', profile: { name: 'Synthetic' } }]
      : route === 'GET /v1/task-context-sessions/current' ? null
      : route === 'PUT /v1/task-contexts' ? request.body
      : route === 'GET /v1/collaboration-preferences' ? { personal_space_id: searchParams.get('personal_space_id'),
        personal_project_id: searchParams.get('personal_project_id'), project_agent_id: searchParams.get('project_agent_id'),
        effective_preferences: [], global_preferences: [], conflicts: [] }
      : route === 'POST /v1/project-agent-context/resolve' ? { status: 'ready', reason: 'project_lead', agent: AGENT } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, stats, fetchImpl };
}

// Every recovery step a partial entry lists is a call its tool accepts as given.
async function assertExecutable(missing) {
  const tools = new Map(listAgentTools().map(definition => [definition.name, definition]));
  for (const step of missing) {
    assert.ok(tools.has(step.tool), `${step.tool} is a FULI tool`);
    const parsed = await createToolInputValidator(tools.get(step.tool).inputSchema).parse(step.arguments ?? {});
    assert.equal(parsed.success, true, `${step.tool} accepts ${JSON.stringify(step.arguments)}`);
  }
}

async function syntheticHost(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fuli-entry-latency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtimeConfigPath = join(dir, 'runtime.json');
  await writeFile(runtimeConfigPath, JSON.stringify({ version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:9',
    accessToken: 'synthetic-token', principalId: 'synthetic-principal', spaceId: 'synthetic-space' } }));
  await writeFile(join(dir, 'adaptive-runtime-settings.json'), JSON.stringify({ version: 1, enabled: false }));
  const cwd = join(dir, 'synthetic-project');
  await mkdir(join(cwd, '.git'), { recursive: true });
  const input = { session_id: 'synthetic-session', turn_id: 'synthetic-turn', cwd, prompt: 'Synthetic scheduled check',
    transcript_path: join(dir, 'missing.jsonl'), hook_event_name: 'UserPromptSubmit' };
  const dependencies = provider => ({ readInput: async () => input, resolveRuntimeOptions: () => ({ runtimeConfigPath }),
    openApplication: options => openFederatedGraphApplication({ ...options, fetchImpl: provider.fetchImpl }) });
  return { runtimeConfigPath, dependencies };
}

// The project list with the entry's own current-task lookup (the first one is
// the transcript capture's), health with the Agent's resolution, and the
// preferences with the Agent's continuity.
const TOGETHER = [
  ['GET /v1/personal-projects#1', 'GET /v1/task-context-sessions/current#2'],
  ['GET /health#1', 'POST /v1/project-agent-context/resolve#1'],
  ['GET /v1/collaboration-preferences#1', 'GET /v1/project-agent-tasks#1']
];

test('task entry reads independent Provider data in parallel and the project list once', async t => {
  const host = await syntheticHost(t);
  const provider = fakeProvider({ latencyMs: 5, together: TOGETHER });
  const output = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], { ...host.dependencies(provider), write: () => {} });
  const { requests, stats } = provider;
  const find = key => requests.find(request => request.key === key);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  // Directory resolution and the managers' project check share one read.
  assert.equal(requests.filter(request => request.route === 'GET /v1/personal-projects').length, 1);
  // Each pair was in flight together: both started before either answered.
  for (const [a, b] of TOGETHER) {
    assert.ok(find(a) && find(b), `${a} and ${b} were requested`);
    assert.ok(find(a).start < find(b).end && find(b).start < find(a).end, `${a} overlaps ${b}`);
  }
  assert.ok(stats.maxInFlight >= 2);
  // A read that needs another's answer still waits for it, and the task is
  // written only after every read it is built from.
  assert.ok(find('GET /v1/collaboration-preferences#1').start > find('POST /v1/project-agent-context/resolve#1').end);
  const write = find('PUT /v1/task-contexts#1');
  assert.ok(requests.filter(request => request.start < write.start).every(request => request.end < write.start));
});

test('at the deadline an entry that wrote its task delivers the token and names what is missing with its tool', async t => {
  // The hook's deadline timer and its entry budget's clock (Date.now) are
  // mocked: the deadline comes only when the test ticks it, after the entry
  // answered its task write, so a slow host cannot reach it first.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const host = await syntheticHost(t);
  const provider = fakeProvider({ latencyMs: 5 });
  const writes = [];
  const result = await runCodexLifecycleCommand(['--event', 'UserPromptSubmit', '--timeout-ms', '1500'], {
    ...host.dependencies(provider), write: value => writes.push(value),
    // The entry is built and its task written; what follows answers only after the deadline.
    callTool: async (app, name, parameters, options) => {
      const value = await callAgentTool(app, name, parameters, options);
      if (name !== 'begin_task_context') return value;
      const aborted = new Promise(resolve => options.signal.addEventListener('abort', resolve));
      const taskWrite = provider.requests.find(request => request.route === 'PUT /v1/task-contexts');
      assert.ok(taskWrite?.end, 'the deadline is held until the task write has been answered');
      t.mock.timers.tick(1500);
      await aborted;
      return value;
    }
  });
  assert.equal(result.timedOut, true);
  assert.equal(writes.length, 1);
  const output = JSON.parse(writes[0]);
  assert.match(output.systemMessage, /partial \(no answer within 1500 ms\)/);
  const [label, json] = output.hookSpecificOutput.additionalContext.split('\n');
  assert.match(label, /^Fuli task context is partial/);
  const context = JSON.parse(json);
  const token = provider.requests.find(request => request.route === 'PUT /v1/task-contexts').body.token;
  assert.equal(context.taskContextToken, token);
  assert.equal(context.checkpoint_required, false);
  assert.match(context.checkpoint_guidance, /Stop hook closes the task/);
  // The receipt the entry built is delivered; only what this answer leaves out is listed, each as a valid call.
  assert.match(context.agent_receipt.markdown, /^FULI Agent：/);
  assert.deepEqual(context.entry_incomplete.missing.map(item => item.tool), ['read_task_preferences']);
  assert.deepEqual(context.entry_incomplete.missing[0].arguments, { taskContextToken: token });
  await assertExecutable(context.entry_incomplete.missing);
  assert.ok(context.entry_incomplete.missing[0].parts.includes('effective_preferences'));
  assert.equal(context.entry_incomplete.transcript_capture, 'unverified');
  assert.doesNotMatch(writes[0], /Synthetic scheduled check|fuli-entry-latency/);
});

test('a deadline before the task is written delivers no token: the fallback names get_collaboration_preferences', async t => {
  const host = await syntheticHost(t);
  const provider = fakeProvider({ latencyMs: 5, hold: 'PUT /v1/task-contexts' });
  const writes = [];
  const result = await runCodexLifecycleCommand(['--event', 'UserPromptSubmit', '--timeout-ms', '1500'], {
    ...host.dependencies(provider), write: value => writes.push(value) });
  assert.equal(result.timedOut, true);
  assert.equal(writes.length, 1);
  const context = JSON.parse(writes[0]).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(context, /fuli-task-|taskContextToken"/);
  assert.match(context, /First call get_collaboration_preferences with sessionId="synthetic-session"/);
  const marker = JSON.parse(context.slice(context.indexOf('entry_incomplete=') + 'entry_incomplete='.length));
  assert.deepEqual(marker, { reason: 'entry_deadline', missing: [
    { parts: ['task_context', 'effective_preferences'], tool: 'get_collaboration_preferences' }] });
});

test('only a task noted in time, with an Agent its reader can recover, is ever delivered at the deadline', () => {
  let now = 0;
  const task = { task_context_token: 'fuli-task-synthetic-1', context: { project_agent_id: 'project.lead' }, checkpoint_required: true };
  const late = entryBudget(100, { now: () => now });
  now = 100;
  runWithEntryBudget(late, () => noteEntryTask(task));
  assert.equal(partialEntryText(late), null, 'noted after the deadline: cut short');
  now = 0;
  const unassigned = entryBudget(100, { now: () => now });
  runWithEntryBudget(unassigned, () => noteEntryTask({ ...task, context: { project_agent_id: null } }));
  assert.equal(partialEntryText(unassigned), null, 'read_task_preferences cannot recover a task without its Agent');
  const ready = entryBudget(100, { now: () => now });
  runWithEntryBudget(ready, () => noteEntryTask(task));
  assert.match(partialEntryText(ready), /"taskContextToken":"fuli-task-synthetic-1","checkpoint_required":true,"entry_incomplete"/);
  // Outside a hook's budget nothing is noted.
  assert.doesNotThrow(() => noteEntryTask(task));
});

test('Claude Code at its deadline delivers the same partial entry, or its fallback with the marker', () => {
  const input = { session_id: 'synthetic-claude-session', cwd: '/synthetic', prompt: 'Synthetic task' };
  const budget = entryBudget(1000);
  const before = claudeEntryDeadlineOutput('UserPromptSubmit', input, budget);
  assert.match(before.hookSpecificOutput.additionalContext, /get_collaboration_preferences with sessionId="synthetic-claude-session"/);
  assert.match(before.hookSpecificOutput.additionalContext, /entry_incomplete=\{"reason":"entry_deadline"/);
  runWithEntryBudget(budget, () => noteEntryTask({ task_context_token: 'fuli-task-synthetic-2', context: { project_agent_id: 'project.lead' },
    checkpoint_required: true }));
  const after = claudeEntryDeadlineOutput('UserPromptSubmit', input, budget);
  assert.equal(after.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(after.hookSpecificOutput.additionalContext, partialEntryText(budget));
  assert.equal(claudeEntryDeadlineOutput('Stop', input, budget).hookSpecificOutput, undefined);
});

test('a partial entry carries what the entry already held and names every part it omits with its tool', async () => {
  const budget = entryBudget(1000);
  const scope = { type: 'temporary', personal_project_id: 'synthetic-temporary' };
  runWithEntryBudget(budget, () => noteEntryTask({ task_context_token: 'fuli-task-synthetic-3', context: { project_agent_id: 'project.lead' },
    checkpoint_required: true, checkpoint_guidance: null, remember_guidance: 'Synthetic remember guidance.',
    previous_checkpoint_missing: true, project_scope: scope, task_guidance: { checkpoint: 'Synthetic.' },
    effective_preferences: [{ id: 'synthetic-preference' }], agent_messages: [{ message_id: 'synthetic-message' }] }));
  const context = JSON.parse(partialEntryText(budget).split('\n')[1]);
  // Checkpointing is still guided, and the person's request to keep something is not lost.
  assert.equal(context.remember_guidance, 'Synthetic remember guidance.');
  assert.equal(context.previous_checkpoint_missing, true);
  assert.deepEqual(context.project_scope, scope);
  assert.equal('checkpoint_guidance' in context, false, 'an absent field stays absent');
  // Larger parts are fetched on demand, each listed with its tool.
  assert.equal(context.task_guidance, undefined);
  assert.equal(context.effective_preferences, undefined);
  const missing = Object.fromEntries(context.entry_incomplete.missing.flatMap(item => item.parts.map(part => [part, item.tool])));
  assert.equal(missing.task_guidance, 'read_task_preferences');
  assert.equal(missing.effective_preferences, 'read_task_preferences');
  assert.equal(missing.agent_messages, 'read_agent_messages');
  assert.equal('attention_replies' in missing, false, 'none were waiting');
  await assertExecutable(context.entry_incomplete.missing);
});

test('a partial entry keeps the built receipt and management context, and lists only real recovery calls', async () => {
  const budget = entryBudget(1000);
  const receipt = { required: true, markdown: 'FULI Agent：Lead\nFULI 上轮沉淀（补发） 1 条：\n- 新增 事实「Synthetic fact」',
    owner: { agent_id: 'project.lead' }, guidance: 'Synthetic receipt guidance.' };
  const manager = { template_id: 'employee.synthetic-manager', agent_id: 'employee.synthetic-manager', name: 'Synthetic manager',
    personal_project_id: 'synthetic-project', scope_mode: 'all', title_mode: 'suggest', title_style: 'text',
    board: { version: 'v1', total: 1, truncated: false, items: [{ id: 'item-1', title: 'Synthetic item', status: 'todo' }] },
    tools: { discover: 'list_employee_tools', call: 'call_employee_tool', read_board: 'read_board', prepare_title: null },
    guidance: 'Synthetic manager routing.' };
  const memory = { revision: 2, current: { memory: { summary: 'Synthetic notes' } } };
  runWithEntryBudget(budget, () => noteEntryTask({ task_context_token: 'fuli-task-synthetic-5',
    context: { personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project', project_agent_id: 'project.lead' },
    checkpoint_required: true, agent_receipt: receipt, effective_preferences: [], task_guidance: {},
    project_management_context: { status: 'ready', managers: [manager], worker_started: false },
    project_agent_context: { status: 'ready', memory, global_memory: memory }, judgment_context: { agentId: 'employee.tonborg' },
    task_knowledge_recall: { status: 'not_needed', facts: [], entities: [] } }));
  const context = JSON.parse(partialEntryText(budget).split('\n')[1]);
  // Claimed earlier turns' items are shown here or nowhere.
  assert.equal(context.agent_receipt.markdown, receipt.markdown);
  // Routing and title policy as the entry built them; the board is read on demand by its own tool.
  const delivered = context.project_management_context.managers[0];
  assert.equal(delivered.guidance, 'Synthetic manager routing.');
  assert.equal(delivered.title_mode, 'suggest');
  assert.deepEqual(delivered.board, { version: 'v1', total: 1, view: 'on_demand', guidance: delivered.board.guidance });
  await assertExecutable([{ tool: delivered.tools.discover,
    arguments: { templateId: delivered.template_id, personalProjectId: delivered.personal_project_id } }]);
  assert.deepEqual(context.task_knowledge_recall, { status: 'not_needed', facts: [], entities: [] });
  const { missing } = context.entry_incomplete;
  const parts = missing.flatMap(item => item.parts);
  for (const part of ['agent_receipt', 'project_management_context', 'task_knowledge_recall', 'agent_messages']) {
    assert.equal(parts.includes(part), false, `${part} is not listed as missing`);
  }
  assert.deepEqual(missing.map(item => item.tool), ['read_task_preferences', 'get_project_agent_memory', 'get_project_agent_memory']);
  assert.deepEqual(missing[0].parts, ['effective_preferences', 'task_guidance', 'project_agent_context', 'judgment_context']);
  assert.match(missing[0].note, /not working memory/);
  assert.match(missing[0].note, /copy this entry's agent_receipt/);
  assert.deepEqual(missing.slice(1).map(({ parts: [part], arguments: args }) => [part, args.personalProjectId]),
    [['project_agent_context.memory', 'synthetic-project'], ['project_agent_context.global_memory', null]]);
  await assertExecutable(missing);
  await assert.rejects(assertExecutable([{ tool: 'list_employee_tools' }]), 'a call without its required templateId is refused');
});

test('the outdated-MCP notice reaches the deadline answer, and is read only once', () => {
  const input = { session_id: 'synthetic-claude-session', cwd: '/synthetic', prompt: 'Synthetic task' };
  const budget = entryBudget(1000);
  let reads = 0;
  const notice = runWithEntryBudget(budget, () => noteEntryNotice(() => { reads += 1; return 'Synthetic restart notice.'; }));
  assert.equal(reads, 0, 'nothing is read before an answer needs it');
  const fallback = claudeEntryDeadlineOutput('UserPromptSubmit', input, budget);
  assert.match(fallback.systemMessage, /Synthetic restart notice\.$/);
  assert.match(fallback.hookSpecificOutput.additionalContext, /Synthetic restart notice\.$/);
  runWithEntryBudget(budget, () => noteEntryTask({ task_context_token: 'fuli-task-synthetic-4', context: { project_agent_id: 'project.lead' },
    checkpoint_required: true }));
  const partial = claudeEntryDeadlineOutput('UserPromptSubmit', input, budget);
  assert.match(partial.hookSpecificOutput.additionalContext, /Synthetic restart notice\.$/);
  assert.equal(notice(), 'Synthetic restart notice.');
  assert.equal(reads, 1, 'the one-time notice is read once, whichever answer comes first');
  assert.doesNotMatch(claudeEntryDeadlineOutput('Stop', input, budget).systemMessage, /Synthetic restart notice/);
});

test('a project registered or created during an entry is seen by the entry\'s later reads of the shared list', async () => {
  const projects = [{ project_id: 'synthetic-project', profile: { name: 'Synthetic' } }];
  const reads = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (url, init = {}) => {
      const { pathname } = new URL(url);
      const route = `${init.method ?? 'GET'} ${pathname}`;
      if (route === 'GET /v1/personal-projects') reads.push(projects.map(project => project.project_id));
      const body = route === 'GET /v1/personal-projects' ? structuredClone(projects)
        : route === 'PUT /v1/personal-projects' ? projects.push({ project_id: 'synthetic-registered', profile: {} }) && {}
        : route === 'POST /v1/temporary-projects/ensure' ? projects.push({ project_id: 'synthetic-temporary', profile: {} }) && {}
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  const ids = list => list.map(project => project.project_id);
  await withSharedProjectList(async () => {
    assert.deepEqual(ids(await client.listPersonalProjects('synthetic-space')), ['synthetic-project']);
    assert.deepEqual(ids(await client.listPersonalProjects('synthetic-space')), ['synthetic-project']);
    assert.equal(reads.length, 1, 'one read per entry');
    await client.upsertPersonalProject({ personal_space_id: 'synthetic-space', project_id: 'synthetic-registered' });
    assert.deepEqual(ids(await client.listPersonalProjects('synthetic-space')), ['synthetic-project', 'synthetic-registered']);
    await client.ensureTemporaryProject({ personal_space_id: 'synthetic-space' });
    assert.deepEqual(ids(await client.listPersonalProjects('synthetic-space')),
      ['synthetic-project', 'synthetic-registered', 'synthetic-temporary']);
    assert.deepEqual(ids(await client.listPersonalProjects('synthetic-space')),
      ['synthetic-project', 'synthetic-registered', 'synthetic-temporary']);
  });
  assert.equal(reads.length, 3, 'each write drops the shared list once; later reads share the new one');
});
