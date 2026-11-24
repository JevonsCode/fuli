import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { localAnswer } from '../src/runner/local-answer-note.js';
import { callDestination } from '../src/runner/routed-calls.js';
import { hostOwner, LOCAL_OWNER, RoutesStore } from '../src/runner/routes-store.js';
import { RunnerStore } from '../src/runner/runner-store.js';
import { ownIssuer } from '../src/runner/task-issuer.js';
import { reachableModules } from '../test-support/module-graph.js';
import { errorAnswer, jsonAnswer, pairedFollower } from '../test-support/paired-follower.js';

// A follower that owns a project (docs/runner-roles-design.md §4, §12): its own
// half answers that project, everything else still goes to the host. Owning a
// project is not open yet (local-route-refusal.js), so each test writes the
// route by hand. Synthetic computers, folders and tokens only.
const SYNCED = '2026-11-24T08:00:00.000Z';

function ownedProject(follower, { id = 'widgets' } = {}) {
  follower.served.routes.setLocalProject(`project:${id}`, follower.projectPath);
  follower.served.routes.replicaSynced('global', SYNCED);
}

const localEntry = (name) => name === 'get_collaboration_preferences'
  ? jsonAnswer({ effective_preferences: ['short answers'], taskContextToken: 'local-token-1',
    context: { personal_project_id: 'widgets', project_agent_id: 'fla-synthetic' } })
  : jsonAnswer({ status: 'answered_here' });

test('an entry in a project this computer owns is answered here, with this computer\'s name on its token', async (t) => {
  const follower = await pairedFollower(t, { localAnswer: localEntry });
  ownedProject(follower);
  const own = ownIssuer(follower.dataDir);
  assert.match(own, /^[0-9a-f]{16}$/, 'the follower has a device certificate of its own');

  const entry = await follower.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: follower.projectPath, taskPrompt: 'synthetic' } });
  assert.equal(entry.structuredContent.taskContextToken, `fuli-from-${own}.local-token-1`);
  assert.equal(entry.structuredContent.runner.answeredBy, 'this_computer');
  assert.equal(entry.structuredContent.runner.global.syncedAt, SYNCED);
  assert.equal(entry.structuredContent.runner.global.host, 'Host A');
  assert.match(entry.structuredContent.runner.message, /This project is on this computer[\s\S]*这个项目在这台电脑上/);
  assert.equal(follower.calls.some(({ name }) => name === 'get_collaboration_preferences'), false, 'the host was not asked');
  assert.equal(follower.local.opened.length, 1);
  assert.equal(follower.local.opened[0].sourceApplication, 'codex');

  // The checkpoint without a folder comes back here by its token, with or without this computer's name on it.
  await follower.client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: entry.structuredContent.taskContextToken, workLog: { status: 'completed', summary: 'x' } } });
  assert.equal(follower.local.calls.at(-1).name, 'checkpoint_task_knowledge');
  assert.equal(follower.local.calls.at(-1).args.taskContextToken, `fuli-from-${own}.local-token-1`,
    'the half takes its own name off itself');
  await follower.client.callTool({ name: 'checkpoint_task_knowledge', arguments: { taskContextToken: 'local-token-1' } });
  assert.equal(follower.local.calls.at(-1).name, 'checkpoint_task_knowledge', 'remembered as entered here');
  assert.equal(follower.calls.some(({ name }) => name === 'checkpoint_task_knowledge'), false);

  // A call naming the project only by id is that project's.
  await follower.client.callTool({ name: 'fuli_call', arguments: { toolName: 'search_current_project_knowledge',
    input: { personalProjectId: 'widgets', queries: ['deploy'] } } });
  assert.equal(follower.local.calls.at(-1).name, 'fuli_call');

  // Another project and global still go to the host, the half opened once.
  const other = path.join(follower.base, 'gadgets');
  mkdirSync(other);
  await follower.client.callTool({ name: 'search_current_project_knowledge', arguments: { projectPath: other, queries: ['x'] } });
  await follower.client.callTool({ name: 'fuli_call', arguments: { toolName: 'search_current_project_knowledge',
    input: { personalProjectId: 'gadgets', queries: ['x'] } } });
  await follower.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'no folder' } });
  assert.deepEqual(follower.calls.map(({ name }) => name),
    ['search_current_project_knowledge', 'fuli_call', 'get_collaboration_preferences']);
  assert.equal(follower.local.opened.length, 1);
});

test('without a project of its own, a follower never opens its own half, and its entry does not load it', async (t) => {
  const follower = await pairedFollower(t);
  await follower.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: follower.projectPath, taskPrompt: 'synthetic' } });
  await follower.client.callTool({ name: 'fuli_call', arguments: { toolName: 'search_current_project_knowledge',
    input: { personalProjectId: 'widgets', queries: ['x'] } } });
  await follower.client.callTool({ name: 'checkpoint_task_knowledge', arguments: { taskContextToken: 'host-token' } });
  assert.deepEqual(follower.local.opened, []);
  assert.equal(follower.calls.length, 3);
  const loaded = [...reachableModules('src/runner/runner-mcp.js', { dynamicImports: false })].map((file) => path.resolve(file));
  for (const own of ['src/runner/local-scope-server.js', 'src/mcp/local-mcp-core.js', 'src/mcp/create-mcp-server.js',
    'src/graphiti/federated-application.js']) {
    assert.equal(loaded.includes(path.resolve(own)), false, own);
  }
});

test('a tool this computer\'s FULI does not have yet, and the first copy of global not here yet, are said as such', async (t) => {
  const follower = await pairedFollower(t, { localAnswer: (name, args) => args.toolName === 'newer_tool'
    ? errorAnswer('not_found', 'Unknown Fuli tool') : errorAnswer('global_not_synced', 'synthetic') });
  ownedProject(follower);
  const unknown = await follower.client.callTool({ name: 'fuli_call', arguments: { toolName: 'newer_tool',
    input: { personalProjectId: 'widgets' } } });
  const said = JSON.parse(unknown.content[0].text);
  assert.equal(said.code, 'tool_unknown_here');
  assert.match(said.message, /older than on Host A[\s\S]*fuli update[\s\S]*比 Host A 旧/);
  const waiting = await follower.client.callTool({ name: 'fuli_call', arguments: { toolName: 'search_current_project_knowledge',
    input: { personalProjectId: 'widgets' } } });
  assert.match(JSON.parse(waiting.content[0].text).message, /waiting for its first copy of global[\s\S]*第一份全局副本/);
});

test('an entry here without an FLA queues the recruitment the host must make, and says so', async (t) => {
  const recruitment = { recruitment_id: 'recruitment-1', proposed_agent_id: 'agent-1', status: 'blocked',
    reason_code: 'recruitment_on_owner', reason: 'The project needs a lead', personal_project_id: 'widgets',
    proposed_profile: { name: 'Synthetic Lead', responsibility: 'Lead the project' },
    occupation: { role: 'engineering', tags: [] } };
  const localApp = { config: { personal: { spaceId: 'space-synthetic' } }, personal: {
    listProjectAgentRecruitments: async () => [recruitment],
    listPersonalProjects: async () => [{ project_id: 'widgets', name: 'Widgets' }] } };
  const hired = [];
  const hostApp = { config: { personal: { spaceId: 'space-synthetic' } },
    personal: { hireForFollowerRecruitment: async (hire) => { hired.push(hire); return { agent_id: hire.agentId }; } } };
  const follower = await pairedFollower(t, { localApp, hostApp, checkpointWaitMs: 5000,
    localAnswer: () => jsonAnswer({ taskContextToken: 'local-token-2', context: { personal_project_id: 'widgets' } }) });
  ownedProject(follower);
  const entry = await follower.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: follower.projectPath, taskPrompt: 'first task' } });
  assert.ok(entry.structuredContent.runner.recruitment, 'the entry says a recruitment waits');
  for (let tries = 0; tries < 50 && !hired.length; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hired.length, 1, 'the host was asked to make the FLA');
  assert.equal(hired[0].agentId, 'agent-1');
  assert.equal(hired[0].origin.project, 'Widgets');
  // Entered again: queued once, never twice.
  await follower.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: follower.projectPath, taskPrompt: 'second task' } });
  const store = follower.served.store;
  assert.equal(store.outbox().queued, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(hired.length, 1);
});

// Without a project of its own, every call goes where it went before this change, one by one.
test('with routes that follow the host, every call goes where it went before', () => {
  const host = 'a'.repeat(64);
  const store = new RunnerStore(':memory:');
  store.saveHost({ name: 'Host A', fingerprint: host, certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] });
  const routes = new RoutesStore(':memory:');
  routes.followEverything(hostOwner(host));
  routes.set('project:gadgets', hostOwner(host));
  routes.set('project:stale', hostOwner('f'.repeat(64)));
  routes.rememberTaskOwner('host-token', hostOwner(host));
  const cases = [
    [{}, 'host'], [{ projectPath: '/nowhere/synthetic' }, 'host'], [{ personalProjectId: 'widgets' }, 'host'],
    [{ projectId: 'widgets' }, 'host'], [{ project_id: 'widgets' }, 'host'], [{ personalProjectId: 'gadgets' }, 'host'],
    [{ taskContextToken: 'host-token' }, 'host'], [{ taskContextToken: 'never-seen' }, 'host'],
    [{ taskContextToken: 'x', issuer: host.slice(0, 16) }, 'host'],
    [{ taskContextToken: 'x', issuer: 'b'.repeat(16) }, 'task_owner_not_paired']
  ];
  for (const [input, expected] of cases) {
    const { issuer = null, ...rest } = input;
    const destination = callDestination({ routes, store, input: rest, issuer, ownIssuer: 'c'.repeat(16) });
    const said = destination.to ?? JSON.parse(destination.refused.content[0].text).code;
    assert.equal(said, expected, JSON.stringify(input));
  }
  // A project routed to a host this computer left: refused by id as it is by folder (before, an id alone went to `global`).
  assert.equal(JSON.parse(callDestination({ routes, store, input: { personalProjectId: 'stale' } }).refused.content[0].text).code,
    'scope_owner_not_paired');
  // `global` marked as this computer's is refused, never answered here.
  routes.set('global', LOCAL_OWNER);
  assert.equal(JSON.parse(callDestination({ routes, store, input: {} }).refused.content[0].text).code, 'scope_owned_here');
  routes.close();
  store.close();
});

test('a checkpoint here says what it saved here and what became of its writes to global', () => {
  const answer = jsonAnswer({ status: 'checkpointed', saved_here: 2,
    for_host: { delivered: 1, queued: 1, refused: [{ kind: 'agent_memory', code: 'capture_disabled' }] } });
  const noted = localAnswer('checkpoint_task_knowledge', answer, { hostName: 'Host A', heldForOldHost: false });
  const { runner } = noted.structuredContent;
  assert.equal(runner.savedHere, 2);
  assert.match(runner.message, /Saved here: 2\. 1 of global went to Host A[\s\S]*1 of global wait[\s\S]*refused 1 \(agent_memory capture_disabled\)/);
  assert.match(runner.message, /本机记下 2 条。1 条属于全局，已交给 Host A。1 条全局写入在排队/);
  const held = localAnswer('checkpoint_task_knowledge', jsonAnswer({ saved_here: 0, for_host: { delivered: 0, queued: 1, refused: [] } }),
    { hostName: 'Host A', heldForOldHost: true });
  assert.match(held.structuredContent.runner.message, /too old to take them[\s\S]*版本旧/);
  // A checkpoint with nothing for the host is this computer's answer as it is.
  const plain = jsonAnswer({ status: 'checkpointed' });
  assert.equal(localAnswer('checkpoint_task_knowledge', plain, { hostName: 'Host A' }), plain);
});
