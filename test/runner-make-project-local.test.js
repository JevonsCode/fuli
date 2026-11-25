import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openRoutes } from '../src/runner/call-routes.js';
import { writeRecord } from '../src/runner/follower-local-runtime.js';
import { keepProjectChoices, makeProjectLocal, openingRefusal } from '../src/runner/make-project-local.js';
import { MAKING_PROJECT_MARKER, makingProject } from '../src/runner/making-project.js';
import { hostOwner, RoutesStore } from '../src/runner/routes-store.js';
import { RunnerStore } from '../src/runner/runner-store.js';
import { errorAnswer, jsonAnswer, pairedFollower } from '../test-support/paired-follower.js';

// Making a new project this computer's (make-project-local.js). Its runtime is
// not prepared in these folders (local-route-refusal.js refuses), so every
// later step is driven with a refusal that lets it through, and with this
// computer's graph said to run. Synthetic folders and projects only.
const HOST = { name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] };
const open = () => null;

function computer(t, { copy = true } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-make-local-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const folder = path.join(base, 'widgets');
  mkdirSync(folder);
  const store = new RunnerStore(':memory:');
  store.saveHost(HOST);
  const routes = new RoutesStore(':memory:');
  routes.followEverything(hostOwner(HOST.fingerprint));
  if (copy) routes.replicaSynced('global', '2026-11-24T08:00:00.000Z');
  t.after(() => { routes.close(); store.close(); });
  const local = { calls: [], projects: [], fail: null, opened: 0 };
  local.application = async () => { local.opened += 1; return { config: { personal: { spaceId: 'space-synthetic' } } }; };
  local.call = async (name, args) => {
    local.calls.push({ name, args });
    if (name === 'list_personal_projects') return jsonAnswer(local.projects);
    if (local.fail) return errorAnswer(local.fail, 'synthetic refusal');
    local.projects.push({ project_id: args.projectId, name: args.profile.name });
    return jsonAnswer({ project_id: args.projectId });
  };
  return { base, folder, store, routes, local, dataDir: base };
}

// The projects routed to this computer, each with the folder its route keeps.
const localProjects = (routes) => routes.all().filter((row) => row.owner === 'local' && row.scope.startsWith('project:'))
  .map(({ scope, folder }) => ({ scope, folder }));

const make = (machine, options = {}) => makeProjectLocal({ dataDir: machine.dataDir, routes: machine.routes, store: machine.store,
  folder: machine.folder, local: machine.local, hostWritesGlobal: true, hostProjects: async () => [], refusal: open,
  awaitRuntime: async () => true, ...options });

test('while owning a project is not open, nothing is asked, made or routed', async (t) => {
  const machine = computer(t);
  const said = await make(machine, { refusal: undefined });
  assert.equal(said.refused.code, 'local_runtime_not_ready');
  assert.equal(machine.local.opened, 0, 'this computer\'s own half is never opened');
  assert.equal(localProjects(machine.routes).length, 0);
  assert.equal(openingRefusal({ dataDir: machine.dataDir, routes: machine.routes, store: machine.store, hostWritesGlobal: true })
    .code, 'local_runtime_not_ready', 'and the tool is not listed');
});

test('a host too old for writes to global, or no copy of global yet: refused, said as such', async (t) => {
  assert.equal((await make(computer(t), { hostWritesGlobal: false })).refused.code, 'host_needs_update');
  assert.equal((await make(computer(t, { copy: false }))).refused.code, 'waiting_for_copy');
  // Asked of the host only once this computer may own a project; the host away is said as away, not as too old.
  let asked = 0;
  const closed = await make(computer(t), { refusal: undefined, hostWritesGlobal: async () => { asked += 1; return true; } });
  assert.equal(closed.refused.code, 'local_runtime_not_ready');
  assert.equal(asked, 0, 'the host is not asked while owning a project is closed');
  assert.equal((await make(computer(t), { hostWritesGlobal: async () => null })).refused.code, 'host_needed_to_check');
});

test('the host answering with an error, or with no list of projects, is said as that, not as the host away', async (t) => {
  const unreadable = computer(t);
  assert.equal((await make(unreadable, { hostProjects: async () => ({ status: 'recorded' }) })).refused.code, 'host_could_not_check');
  assert.equal(localProjects(unreadable.routes).length, 0);
  const machine = computer(t);
  const said = await make(machine, { hostProjects: async () => ({ hostError: 'provider_unavailable' }) });
  assert.equal(said.refused.code, 'host_could_not_check');
  assert.match(said.refused.message, /answered with an error \(provider_unavailable\)[\s\S]*它那边出错了/);
  assert.doesNotMatch(said.refused.message, /connected|连上/);
  assert.equal(machine.local.calls.length, 0);
  assert.equal(localProjects(machine.routes).length, 0);
});

test('a project the host has, by id, by name or by this folder, is refused and nothing is made', async (t) => {
  for (const host of [[{ project_id: 'widgets', name: 'Other' }], [{ project_id: 'other', name: 'widgets' }]]) {
    const machine = computer(t);
    const said = await make(machine, { hostProjects: async () => host });
    assert.equal(said.refused.code, 'project_on_host', JSON.stringify(host));
    assert.match(said.refused.message, /Host A/);
    assert.equal(machine.local.calls.length, 0);
  }
  const machine = computer(t);
  // Another id asked for, but the host's own resolver says this folder is its project `widgets`.
  const said = await make(machine, { projectId: 'custom-id', hostProjects: async () => [{ project_id: 'widgets', name: 'W' }] });
  assert.equal(said.refused.code, 'project_on_host');
  assert.equal(localProjects(machine.routes).length, 0);
});

test('with the host away nothing is made: the host could make the same project meanwhile', async (t) => {
  const machine = computer(t);
  const said = await make(machine, { hostProjects: async () => null });
  assert.equal(said.refused.code, 'host_needed_to_check');
  assert.match(said.refused.message, /connected[\s\S]*等两台电脑连上再试/);
  assert.equal(machine.local.calls.length, 0);
  assert.equal(localProjects(machine.routes).length, 0);
});

test('made here first, routed only then; made but not routed is routed the next time', async (t) => {
  const machine = computer(t);
  const said = await make(machine);
  assert.deepEqual(said, { status: 'local', scope: 'project:widgets', folder: machine.folder, made: true });
  const upsert = machine.local.calls.find((call) => call.name === 'upsert_personal_project');
  assert.equal(upsert.args.createOnly, true, 'an existing project is never replaced');
  assert.equal(upsert.args.personalSpaceId, 'space-synthetic');
  assert.deepEqual(localProjects(machine.routes), [{ scope: 'project:widgets', folder: machine.folder }]);

  const failing = computer(t);
  failing.local.fail = 'provider_error';
  assert.equal((await make(failing)).refused.code, 'provider_error');
  assert.equal(localProjects(failing.routes).length, 0, 'not made: not routed');

  const interrupted = computer(t);
  interrupted.local.projects.push({ project_id: 'widgets', name: 'widgets' });
  const again = await make(interrupted);
  assert.equal(again.made, false);
  assert.equal(interrupted.local.calls.some((call) => call.name === 'upsert_personal_project'), false);
  assert.equal(localProjects(interrupted.routes).length, 1);
});

test('a folder that is not absolute is refused before anything is asked', async (t) => {
  const machine = computer(t);
  assert.equal((await make(machine, { folder: 'relative/widgets' })).refused.code, 'invalid_input');
  assert.equal(machine.local.opened, 0);
});

test('the follower\'s own tool says why it cannot keep a project here yet, and is not listed', async (t) => {
  const follower = await pairedFollower(t);
  const listed = await follower.client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === 'keep_project_on_this_computer'), false);
  const answer = await follower.client.callTool({ name: 'keep_project_on_this_computer',
    arguments: { projectPath: follower.projectPath } });
  const said = JSON.parse(answer.content[0].text);
  assert.equal(answer.isError, true);
  assert.equal(said.code, 'local_runtime_not_ready');
  assert.match(said.message, /own runtime is not ready[\s\S]*运行时还没准备好/);
  assert.deepEqual(follower.local.opened, []);
  assert.equal(localProjects(follower.served.routes).length, 0);
});

test('while it is made, the console is told to start this computer\'s graph; one that does not start makes nothing', async (t) => {
  const machine = computer(t);
  let seen = null;
  const said = await make(machine, { awaitRuntime: async (dataDir) => { seen = makingProject(dataDir); return true; } });
  assert.equal(said.status, 'local');
  assert.equal(seen, true, 'asked for while it is made');
  assert.equal(existsSync(path.join(machine.dataDir, MAKING_PROJECT_MARKER)), false, 'and no longer once it is');

  const idle = computer(t);
  const refused = await make(idle, { awaitRuntime: async () => false });
  assert.equal(refused.refused.code, 'local_runtime_not_running');
  assert.match(refused.refused.message, /did not start[\s\S]*图谱没有在/);
  assert.equal(idle.local.calls.length, 0, 'nothing asked of this computer\'s graph');
  assert.equal(localProjects(idle.routes).length, 0);
  assert.equal(makingProject(idle.dataDir), false);
});

test('ready under the host\'s space with the host\'s copy here, the person\'s AI keeps a new project here', async (t) => {
  const follower = await pairedFollower(t, {
    // Asked by name or, in the chat profile, through fuli_call.
    hostAnswer: (name, input) => [name, input?.toolName].includes('list_personal_projects')
      ? { projects: [{ project_id: 'on-host', name: 'On host' }] } : { status: 'recorded' },
    localApp: { config: { personal: { spaceId: 'space-synthetic' } } },
    localAnswer: (name, args) => jsonAnswer(name === 'list_personal_projects' ? { projects: [] } : { project_id: args.projectId }) });
  writeRecord(follower.dataDir, { state: 'ready', createdHere: true, projects: [], running: false,
    space: { state: 'same', id: 'space-synthetic' } });
  const routes = openRoutes(follower.dataDir);
  routes.replicaSynced('global', '2026-11-24T08:00:00.000Z');
  routes.close();
  // The follower console running this computer's graph, as it records it (follower-runtime-broker.js).
  writeFileSync(path.join(follower.dataDir, 'graph-runtime-state.json'), JSON.stringify({ follower: true, pid: process.pid }));
  const folder = path.join(follower.base, 'checkout-x');
  mkdirSync(folder);
  // Listed once the host answered with its hello (it applies writes to global).
  await follower.client.callTool({ name: 'list_personal_projects', arguments: {} });
  const listed = await follower.client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === 'keep_project_on_this_computer'), true);
  const answer = await follower.client.callTool({ name: 'keep_project_on_this_computer',
    arguments: { projectPath: folder, projectId: 'synthetic-widgets' } });
  assert.equal(answer.isError, undefined, JSON.stringify(answer));
  assert.equal(JSON.parse(answer.content[0].text).scope, 'project:synthetic-widgets');
  const upsert = follower.local.calls.find((call) => call.name === 'upsert_personal_project');
  assert.equal(upsert.args.projectId, 'synthetic-widgets');
  assert.deepEqual(localProjects(follower.served.routes), [{ scope: 'project:synthetic-widgets', folder }]);
  // A project the host has stays the host's.
  const onHost = await follower.client.callTool({ name: 'keep_project_on_this_computer',
    arguments: { projectPath: path.join(follower.base, 'widgets'), projectId: 'on-host' } });
  assert.equal(JSON.parse(onHost.content[0].text).code, 'project_on_host', onHost.content[0].text);
  assert.equal(localProjects(follower.served.routes).length, 1);
});

test('the page offers the folders worked in here that no project is known for, newest first, and why not when it cannot', (t) => {
  const machine = computer(t);
  const dataDir = machine.dataDir;
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: [], running: false,
    space: { state: 'same', id: 'space-synthetic' } });
  const routes = openRoutes(dataDir);
  routes.followEverything(hostOwner(HOST.fingerprint));
  routes.replicaSynced('global', '2026-11-24T08:00:00.000Z');
  routes.setLocalProject('project:widgets', machine.folder);
  routes.close();
  const store = new RunnerStore(path.join(dataDir, 'runner', 'runner.sqlite'));
  t.after(() => store.close());
  store.saveHost(HOST);
  const entry = (folder, projectId) => store.rememberAnswer(`entry:session:${folder}`, 'get_collaboration_preferences',
    jsonAnswer({ context: { personal_project_id: projectId } }));
  entry(path.join(machine.base, 'older'), null);
  entry(path.join(machine.base, 'on-host'), 'on-host');
  entry(path.join(machine.base, 'newer'), null);
  const open = keepProjectChoices({ dataDir, store, hostWritesGlobal: true });
  assert.equal(open.refusal, null);
  assert.deepEqual(new Set(open.folders), new Set([path.join(machine.base, 'older'), path.join(machine.base, 'newer')]),
    'a folder a project is known for is not offered');
  assert.deepEqual(open.localProjects, [{ id: 'widgets', scope: 'project:widgets', folder: machine.folder }]);
  const unknown = keepProjectChoices({ dataDir, store, hostWritesGlobal: null });
  assert.equal(unknown.refusal.code, 'host_needed_to_check', 'the host not reached yet is not said as too old');
  assert.deepEqual(unknown.folders, []);
});
