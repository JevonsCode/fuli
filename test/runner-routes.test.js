import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runRoutesCommand } from '../src/cli/routes-command.js';
import { runRunnerCommand } from '../src/cli/runner-command.js';
import { callScope, openRoutes, routeOfCall } from '../src/runner/call-routes.js';
import { hostOwner, LOCAL_OWNER, RoutesStore, scopeName } from '../src/runner/routes-store.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';

// docs/runner-roles-design.md §3, §4, §10. Synthetic computers and folders only.
const HOST = { name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['10.0.0.20'] };

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

test('a call\'s scope is read from the folder on this computer: global without one, the repository otherwise', (t) => {
  const dataDir = dataDirectory(t, { paired: false });
  assert.equal(callScope(null), 'global');
  assert.equal(callScope(''), 'global');
  const repository = path.join(dataDir, 'widgets');
  mkdirSync(path.join(repository, '.git', 'x'), { recursive: true });
  mkdirSync(path.join(repository, 'src'));
  assert.equal(callScope(path.join(repository, 'src'), { remoteKey: () => 'example.test/team/widgets' }),
    'project:example.test/team/widgets', 'the origin remote, as the owner matches it');
  assert.equal(callScope(path.join(repository, 'src'), { remoteKey: () => null }), `project:path:${repository}`);
});

test('a task\'s checkpoint goes to the computer that entered the task, whatever the routes became', () => {
  const routes = new RoutesStore(':memory:');
  routes.set('default', hostOwner('a'.repeat(64)));
  routes.rememberTaskOwner('task-token-1', hostOwner('b'.repeat(64)));
  assert.deepEqual(routeOfCall(routes, { taskContextToken: 'task-token-1' }),
    { scope: 'global', owner: hostOwner('b'.repeat(64)), byTask: true });
  assert.deepEqual(routeOfCall(routes, { taskContextToken: 'never-seen' }),
    { scope: 'global', owner: hostOwner('a'.repeat(64)), byTask: false });
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
