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

// Every request is logged with its start and end; `hold` keeps one route
// pending until the request is cancelled.
function fakeProvider({ latencyMs, hold = null }) {
  const requests = [];
  const started = Date.now();
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const route = `${init.method ?? 'GET'} ${pathname}`;
    const request = { route, start: Date.now() - started, end: null, body: init.body ? JSON.parse(init.body) : null };
    requests.push(request);
    await delay(route === hold ? 5000 : latencyMs, undefined, { signal: init.signal });
    request.end = Date.now() - started;
    const body = route === 'GET /v1/personal-projects' ? [{ project_id: 'synthetic-project', profile: { name: 'Synthetic' } }]
      : route === 'GET /v1/task-context-sessions/current' ? null
      : route === 'PUT /v1/task-contexts' ? request.body
      : route === 'GET /v1/collaboration-preferences' ? { personal_space_id: searchParams.get('personal_space_id'),
        personal_project_id: searchParams.get('personal_project_id'), project_agent_id: searchParams.get('project_agent_id'),
        effective_preferences: [], global_preferences: [], conflicts: [] }
      : route === 'POST /v1/project-agent-context/resolve' ? { status: 'ready', reason: 'project_lead', agent: AGENT } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, fetchImpl };
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

const overlaps = (requests, a, b) => requests.some(x => x.route === a && requests.some(y => y.route === b
  && x.start < y.end && y.start < x.end));

test('task entry reads independent Provider data in parallel and the project list once', async t => {
  const host = await syntheticHost(t);
  const latencyMs = 60;
  const provider = fakeProvider({ latencyMs });
  const output = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], { ...host.dependencies(provider), write: () => {} });
  const { requests } = provider;
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  // Directory resolution and the managers' project check share one read.
  assert.equal(requests.filter(request => request.route === 'GET /v1/personal-projects').length, 1);
  // The project list runs while the session's task is looked up, health while
  // the Agent is resolved, and the preferences with the Agent's continuity.
  assert.ok(overlaps(requests, 'GET /v1/personal-projects', 'GET /v1/task-context-sessions/current'));
  assert.ok(overlaps(requests, 'GET /health', 'POST /v1/project-agent-context/resolve'));
  assert.ok(overlaps(requests, 'GET /v1/collaboration-preferences', 'GET /v1/project-agent-tasks'));
  // A read that needs another's answer still waits for it, and the task is
  // written only after every read it is built from.
  const resolve = requests.find(request => request.route === 'POST /v1/project-agent-context/resolve');
  const preferences = requests.find(request => request.route === 'GET /v1/collaboration-preferences');
  assert.ok(preferences.start >= resolve.end);
  const write = requests.find(request => request.route === 'PUT /v1/task-contexts');
  assert.ok(requests.filter(request => request.start < write.start).every(request => request.end <= write.start));
  // Far below the same requests one after another, measured on the requests themselves.
  const answered = requests.filter(request => request.end !== null);
  const span = Math.max(...answered.map(request => request.end)) - Math.min(...answered.map(request => request.start));
  const serial = answered.reduce((sum, request) => sum + request.end - request.start, 0);
  assert.ok(span < serial * 0.75, `${span} ms span for ${serial} ms of requests`);
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
