import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { callAgentTool } from '../src/agent-tools.js';
import { claudeEntryDeadlineOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { runCodexLifecycleCommand, runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { entryBudget, noteEntryTask, partialEntryText, runWithEntryBudget } from '../src/conversations/entry-budget.js';
import { openFederatedGraphApplication } from '../src/graphiti/federated-application.js';

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
  const host = await syntheticHost(t);
  const provider = fakeProvider({ latencyMs: 5 });
  const writes = [];
  const result = await runCodexLifecycleCommand(['--event', 'UserPromptSubmit', '--timeout-ms', '1500'], {
    ...host.dependencies(provider), write: value => writes.push(value),
    // The entry is built and its task written; what follows answers only after the deadline.
    callTool: async (app, name, parameters, options) => {
      const value = await callAgentTool(app, name, parameters, options);
      if (name === 'begin_task_context') await new Promise(resolve => options.signal.addEventListener('abort', resolve));
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
  assert.deepEqual(context.entry_incomplete.missing.map(item => item.tool),
    ['read_task_preferences', 'list_employee_tools', 'search_current_project_knowledge']);
  assert.deepEqual(context.entry_incomplete.missing[0].arguments, { taskContextToken: token });
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
  const task = { token: 'fuli-task-synthetic-1', projectAgentId: 'project.lead', checkpointRequired: true };
  const late = entryBudget(100, { now: () => now });
  now = 100;
  runWithEntryBudget(late, () => noteEntryTask(task));
  assert.equal(partialEntryText(late), null, 'noted after the deadline: cut short');
  now = 0;
  const unassigned = entryBudget(100, { now: () => now });
  runWithEntryBudget(unassigned, () => noteEntryTask({ ...task, projectAgentId: null }));
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
  runWithEntryBudget(budget, () => noteEntryTask({ token: 'fuli-task-synthetic-2', projectAgentId: 'project.lead', checkpointRequired: true }));
  const after = claudeEntryDeadlineOutput('UserPromptSubmit', input, budget);
  assert.equal(after.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(after.hookSpecificOutput.additionalContext, partialEntryText(budget));
  assert.equal(claudeEntryDeadlineOutput('Stop', input, budget).hookSpecificOutput, undefined);
});
