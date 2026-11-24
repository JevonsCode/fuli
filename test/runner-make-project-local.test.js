import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeProjectLocal, openingRefusal } from '../src/runner/make-project-local.js';
import { hostOwner, RoutesStore } from '../src/runner/routes-store.js';
import { RunnerStore } from '../src/runner/runner-store.js';
import { errorAnswer, jsonAnswer, pairedFollower } from '../test-support/paired-follower.js';

// Making a new project this computer's (make-project-local.js). Closed in this
// version (local-route-refusal.js refuses), so every later step is driven with
// a refusal that lets it through. Synthetic folders and projects only.
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
  folder: machine.folder, local: machine.local, hostWritesGlobal: true, hostProjects: async () => [], refusal: open, ...options });

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

test('the host answering with an error is said as that, not as the host away', async (t) => {
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
