import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { runRoutesCommand } from '../src/cli/routes-command.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';
import { runRunnerCommand } from '../src/cli/runner-command.js';
import { callScope, openRoutes, routeOfCall } from '../src/runner/call-routes.js';
import { hostOwner, LOCAL_OWNER, RoutesStore, scopeName, TASK_OWNER_DAYS } from '../src/runner/routes-store.js';
import { issuedToken, withIssuedToken } from '../src/runner/task-issuer.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';

// docs/runner-roles-design.md §3, §4, §10. Synthetic computers and folders only.
const HOST = { name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] };

function dataDirectory(t, { paired = true } = {}) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-routes-')));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  if (paired) {
    mkdirSync(path.join(dataDir, 'runner'), { recursive: true });
    const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
    store.saveHost(HOST);
    store.enqueue({ id: 'waiting-1', tool: 'checkpoint_task_knowledge', input: { workLog: 'synthetic' }, sourceApplication: 'codex' });
    store.close();
  }
  return dataDir;
}

test('a computer with no routes owns everything it has, and follows nothing', (t) => {
  const dataDir = dataDirectory(t, { paired: false });
  const routes = openRoutes(dataDir);
  assert.deepEqual(routes.all(), [], 'nothing is routed');
  assert.equal(routes.owner('global'), LOCAL_OWNER);
  assert.equal(routes.owner('project:example.test/team/widgets'), LOCAL_OWNER);
  routes.close();
});

// §10: a beta runner data directory becomes `global → host`, `default → host`, and keeps its outbox.
test('a runner paired by an earlier version follows its host for everything, with its outbox kept', (t) => {
  const dataDir = dataDirectory(t);
  const routes = openRoutes(dataDir);
  assert.deepEqual(routes.all().map((row) => [row.scope, row.owner]),
    [['global', hostOwner(HOST.fingerprint)], ['default', hostOwner(HOST.fingerprint)]]);
  assert.equal(routes.owner('project:example.test/team/widgets'), hostOwner(HOST.fingerprint), 'default covers every project');
  routes.close();
  const runner = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  assert.equal(runner.outbox().queued, 1, 'nothing waiting is lost on the way');
  runner.close();

  // Written once: a route the person changed later stays.
  const again = openRoutes(dataDir);
  again.set('project:example.test/team/widgets', LOCAL_OWNER);
  again.close();
  const third = openRoutes(dataDir);
  assert.equal(third.owner('project:example.test/team/widgets'), LOCAL_OWNER);
  third.close();
});

// Review of #1075: the scope of a folder is the host's answer by the host's own rules, never a second set.
test('a call\'s scope is the project the host resolves its folder to, by the host\'s own rules', (t) => {
  const dataDir = dataDirectory(t, { paired: false });
  const repository = path.join(dataDir, 'checkouts', 'any-folder-name');
  mkdirSync(path.join(repository, '.git'), { recursive: true });
  mkdirSync(path.join(repository, 'src'));
  const plain = path.join(dataDir, 'notes');
  mkdirSync(plain);
  const widgets = path.join(dataDir, 'widgets');
  mkdirSync(path.join(widgets, '.git'), { recursive: true });
  const known = [{ id: 'widgets-project', folder: repository }, { id: 'widgets', folder: null }];

  assert.equal(callScope(null, { known }), 'global');
  assert.equal(callScope('', { known }), 'global');
  // What the host itself answered for this repository, whatever the folder is called, from any folder of it.
  assert.equal(callScope(repository, { known }), 'project:widgets-project');
  assert.equal(callScope(`${repository}/`, { known }), 'project:widgets-project', 'a trailing slash is the same folder');
  assert.equal(callScope(path.join(repository, 'src'), { known }), 'project:widgets-project');
  // A folder the host never answered: the host's resolver, asked about the projects known here.
  assert.equal(callScope(widgets, { known }), 'project:widgets', 'its repository root names a known project');
  // A folder of no known project, a relative path, a path that is not a folder: no project.
  assert.equal(callScope(plain, { known }), 'default');
  assert.equal(callScope('relative/path', { known }), 'default');
  assert.equal(callScope(path.join(dataDir, 'missing'), { known }), 'default');
});

test('a task\'s checkpoint goes to the computer that entered the task, whatever the routes became', () => {
  const routes = new RoutesStore(':memory:');
  routes.set('default', hostOwner('a'.repeat(64)));
  routes.rememberTaskOwner('task-token-1', hostOwner('b'.repeat(64)));
  assert.deepEqual(routeOfCall(routes, { taskContextToken: 'task-token-1' }),
    { scope: 'global', owner: hostOwner('b'.repeat(64)), issuer: null, byTask: true });
  assert.deepEqual(routeOfCall(routes, { taskContextToken: 'never-seen' }),
    { scope: 'global', owner: hostOwner('a'.repeat(64)), issuer: null, byTask: false });
  routes.close();
});

test('scope names are checked at the boundary', () => {
  assert.equal(scopeName(' global '), 'global');
  assert.equal(scopeName('project:example.test/team/widgets'), 'project:example.test/team/widgets');
  for (const bad of ['', 'project:', 'everything', 'project:\u0000x', 42, null]) assert.equal(scopeName(bad), null, String(bad));
});

test('fuli routes lists, follows the paired host only, and refuses every local route until owning scopes is built', async (t) => {
  const dataDir = dataDirectory(t);
  const lines = [];
  const write = (line) => lines.push(line);
  await runRoutesCommand(['list', '--data-dir', dataDir], { write });
  assert.match(lines.join('\n'), /global +Host A[\s\S]*default +Host A/);

  lines.length = 0;
  await runRoutesCommand(['follow', 'project:example.test/team/widgets', 'Host A', '--data-dir', dataDir], { write });
  assert.match(lines.join('\n'), /project:example\.test\/team\/widgets → Host A/);
  await runRoutesCommand(['follow', 'project:example.test/team/widgets', 'aaaaaaaa', '--data-dir', dataDir], { write });

  await assert.rejects(runRoutesCommand(['follow', 'global', 'Other host', '--data-dir', dataDir], { write }),
    { code: 'unknown_host' }, 'only the paired host');
  await assert.rejects(runRoutesCommand(['follow', 'global', 'aaaa', '--data-dir', dataDir], { write }),
    { code: 'unknown_host' }, 'a fingerprint prefix needs 8 characters at least');
  await assert.rejects(runRoutesCommand(['follow', 'everything', 'Host A', '--data-dir', dataDir], { write }), TypeError);
  // Owning a scope on a follower is not built yet (step 3): refused whatever this computer has, a FULI of its
  // own included, so no store of this version holds a second owner for a scope; `global` never.
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), '{"synthetic":true}');
  await assert.rejects(runRoutesCommand(['local', 'project:example.test/team/widgets', '--data-dir', dataDir], { write }),
    (error) => error.code === 'local_route_not_yet' && /fuli routes follow/.test(error.message));
  await assert.rejects(runRoutesCommand(['local', 'global', '--data-dir', dataDir], { write }),
    { code: 'global_has_one_owner' });
  const routes = openRoutes(dataDir);
  assert.ok(routes.all().every((row) => row.owner !== LOCAL_OWNER), 'nothing was written');
  routes.close();
});

test('fuli routes follow on a computer paired with no host says so', async (t) => {
  const dataDir = dataDirectory(t, { paired: false });
  await assert.rejects(runRoutesCommand(['follow', 'global', 'Host A', '--data-dir', dataDir], { write: () => {} }),
    { code: 'not_paired' });
  const lines = [];
  await runRoutesCommand(['list', '--data-dir', dataDir], { write: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /follows no other computer/);
});

test('joining a host is 「follow everything」 there; a scope this computer owns stays its own', () => {
  const routes = new RoutesStore(':memory:');
  routes.set('global', hostOwner('a'.repeat(64)));
  routes.set('project:example.test/team/widgets', hostOwner('a'.repeat(64)));
  routes.set('project:example.test/team/notes', LOCAL_OWNER);
  routes.joined(hostOwner('b'.repeat(64)));
  assert.deepEqual(routes.all().map((row) => [row.scope, row.owner]), [
    ['global', hostOwner('b'.repeat(64))], ['default', hostOwner('b'.repeat(64))],
    ['project:example.test/team/notes', LOCAL_OWNER], ['project:example.test/team/widgets', hostOwner('b'.repeat(64))]]);
  routes.close();
});

test('leaving the host deletes the routes to it, so this computer owns everything it has again', async (t) => {
  const dataDir = dataDirectory(t);
  const before = openRoutes(dataDir);
  assert.equal(before.all().length, 2);
  before.close();
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.delivered('waiting-1');
  store.close();
  await runRunnerCommand(['leave', '--data-dir', dataDir], { write: () => {} });
  assert.equal(existsSync(path.join(dataDir, 'runner', 'routes.sqlite')), false);
});

// Review of #1075: the remembered owner of a token is the fallback; only its digest is kept, for 30 days from its last use.
test('a token\'s remembered owner keeps no token and goes 30 days after its last use', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const routes = new RoutesStore(':memory:', { now: () => now });
  routes.rememberTaskOwner('fuli-task-synthetic', hostOwner('a'.repeat(64)));
  assert.equal(routes.db.prepare('SELECT token_sha256 FROM task_owners').get().token_sha256.length, 64);
  now += (TASK_OWNER_DAYS - 1) * 24 * 60 * 60 * 1000;
  assert.equal(routes.taskOwner('fuli-task-synthetic'), hostOwner('a'.repeat(64)), 'used: its days start again');
  now += (TASK_OWNER_DAYS + 1) * 24 * 60 * 60 * 1000;
  assert.equal(routes.taskOwner('fuli-task-synthetic'), null);
  routes.close();
});

test('a token says which FULI issued it, and the host gets its own token back', () => {
  const token = issuedToken('AB'.repeat(32), 'fuli-task-synthetic');
  assert.equal(token, `fuli-from-${'ab'.repeat(8)}.fuli-task-synthetic`);
  assert.ok(token.length <= 128, 'within every tool\'s token length');
  assert.deepEqual(withIssuedToken('checkpoint_task_knowledge', { taskContextToken: token, workLog: 'x' }),
    { issuer: 'ab'.repeat(8), args: { taskContextToken: 'fuli-task-synthetic', workLog: 'x' } });
  assert.deepEqual(withIssuedToken('fuli_call', { toolName: 'resume_agent_conversation', input: { taskContextToken: token } }),
    { issuer: 'ab'.repeat(8), args: { toolName: 'resume_agent_conversation', input: { taskContextToken: 'fuli-task-synthetic' } } });
  assert.deepEqual(withIssuedToken('checkpoint_task_knowledge', { taskContextToken: 'runner-offline-x' }),
    { issuer: null, args: { taskContextToken: 'runner-offline-x' } });
  assert.equal(issuedToken('ab'.repeat(32), token), token, 'never named twice');
});

// Design §7.1, review of #1075: a scope this computer already has data of is not followed elsewhere.
// The console here is the real route (graph-api-router.js) over loopback, with a stub of the app behind it.
async function ownConsole(t, dataDir, { projects = [], fail = null } = {}) {
  const asked = [];
  const app = { config: { personal: { spaceId: 'space-synthetic' } }, listPersonalProjects: async (input) => {
    asked.push(input);
    if (fail) throw Object.assign(new Error('synthetic failure'), { status: fail });
    return projects;
  } };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    handleGraphApiRequest({ request, response, url, app }).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch((error) => { response.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'synthetic_failure' })); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(path.join(dataDir, 'runtime-settings.json'),
    JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, ports: { ...DEFAULT_RUNTIME_SETTINGS.ports, console: server.address().port } }));
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), '{"synthetic":true}');
  return asked;
}

const readConfig = () => ({ personal: { spaceId: 'space-synthetic' } });

test('fuli routes follow refuses a scope this computer\'s own FULI already has, asking its real console route', async (t) => {
  const dataDir = dataDirectory(t);
  const asked = await ownConsole(t, dataDir, { projects: [{ project_id: 'widgets' }, { project_id: 'notes' }] });
  const write = () => {};
  await assert.rejects(runRoutesCommand(['follow', 'project:widgets', 'Host A', '--data-dir', dataDir], { write, readConfig }),
    (error) => error.code === 'scope_has_local_data' && /already has project widgets/.test(error.message));
  assert.deepEqual(asked, [{ personalSpaceId: 'space-synthetic' }], 'this data directory\'s own personal space');
  await assert.rejects(runRoutesCommand(['follow', 'default', 'Host A', '--data-dir', dataDir], { write, readConfig }),
    { code: 'scope_has_local_data' });
  await runRoutesCommand(['follow', 'project:gadgets', 'Host A', '--data-dir', dataDir], { write, readConfig });
  const routes = openRoutes(dataDir);
  assert.deepEqual(routes.all().map((row) => row.scope).filter((scope) => scope.startsWith('project:')), ['project:gadgets']);
  routes.close();
});

test('a console that cannot be reached and one that answers with an error are said apart', async (t) => {
  const refusing = dataDirectory(t);
  await ownConsole(t, refusing, { fail: 503 });
  await assert.rejects(runRoutesCommand(['follow', 'project:gizmos', 'Host A', '--data-dir', refusing],
    { write: () => {}, readConfig }), (error) => error.code === 'local_fuli_refused' && /HTTP 503/.test(error.message));
  const away = dataDirectory(t);
  writeFileSync(path.join(away, 'graph-runtime.json'), '{"synthetic":true}');
  await assert.rejects(runRoutesCommand(['follow', 'project:gizmos', 'Host A', '--data-dir', away], { write: () => {}, readConfig,
    fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { code: 'local_fuli_not_running' });
  await assert.rejects(runRoutesCommand(['follow', 'project:gizmos', 'Host A', '--data-dir', away], { write: () => {},
    readConfig: () => { throw new Error('synthetic: unreadable'); } }), { code: 'local_fuli_unreadable' });
});
