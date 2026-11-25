import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runRoutesCommand } from '../src/cli/routes-command.js';
import { runRunnerCommand } from '../src/cli/runner-command.js';
import { callScope, knownProjects, openRoutes, routeOfCall } from '../src/runner/call-routes.js';
import { holdPreparationLock, writeRecord } from '../src/runner/follower-local-runtime.js';
import { openFormattedDatabase, sqliteFormat } from '../packages/roundtable/src/storage/database-format.js';
import { hostOwner, LOCAL_OWNER, ROUTES_FORMAT, RoutesStore, scopeName, TASK_OWNER_DAYS } from '../src/runner/routes-store.js';
import { callDestination, routesUnavailableAnswer } from '../src/runner/routed-calls.js';
import { resultValue } from '../src/runner/offline-calls.js';
import { answerWithIssuer, issuedToken, tokenIssuedHere, withIssuedToken } from '../src/runner/task-issuer.js';
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
  // What the host itself answered for this very folder, whatever the folder is called.
  assert.equal(callScope(repository, { known }), 'project:widgets-project');
  assert.equal(callScope(`${repository}/`, { known }), 'project:widgets-project', 'a trailing slash is the same folder');
  // Another folder of that repository is the resolver's to answer, never assumed the same project here.
  assert.equal(callScope(path.join(repository, 'src'), { known }), 'default');
  assert.equal(callScope(path.join(repository, 'src'), { known, resolve: () => ({ status: 'matched', personalProjectId: 'x' }) }),
    'project:x', 'whatever the host\'s resolver says');
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

test('fuli routes lists, follows the paired host only, and refuses a local route this computer may not own', async (t) => {
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
  // Refused before the host is reached while this computer may not own the scope, each time with the reason
  // that holds and what to do now, so no store holds a second owner for a scope; `global` never.
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), '{"synthetic":true}');
  await assert.rejects(runRoutesCommand(['local', 'project:example.test/team/widgets', '--data-dir', dataDir], { write }),
    (error) => error.code === 'project_on_host' && /already on Host A/.test(error.message) && /Host A 上已经有了/.test(error.message),
    'a project the host has: moving it is a later step');
  await assert.rejects(runRoutesCommand(['local', 'project:example.test/team/new-one', '--data-dir', dataDir], { write }),
    (error) => error.code === 'local_runtime_not_ready' && /never prepared/.test(error.message) && /fuli start/.test(error.message),
    'a new project while this computer\'s runtime is not prepared: what is missing, and how to get it');
  await assert.rejects(runRoutesCommand(['local', 'global', '--data-dir', dataDir], { write }),
    (error) => error.code === 'global_has_one_owner' && /D1/.test(error.message) && /只有一个所有者/.test(error.message));
  await assert.rejects(runRoutesCommand(['local', 'default', '--data-dir', dataDir], { write }),
    (error) => error.code === 'default_stays' && /Host A/.test(error.message));
  const routes = openRoutes(dataDir);
  assert.ok(routes.all().every((row) => row.owner !== LOCAL_OWNER), 'nothing was written');
  routes.close();
});

test('fuli routes local FOLDER|project:<id> makes a new project this computer\'s the one way every entry does', async (t) => {
  const dataDir = dataDirectory(t);
  const asked = [];
  const lines = [];
  const makeHere = async (input) => {
    asked.push({ folder: input.folder, projectId: input.projectId });
    return input.projectId === 'on-host'
      ? { refused: { code: 'project_on_host', message: 'Project on-host is already on Host A.\n项目 on-host 在 Host A 上已经有了。' } }
      : { status: 'local', scope: `project:${input.projectId ?? path.basename(input.folder)}`, folder: input.folder, made: true };
  };
  const connect = async () => assert.fail('the host is reached only through makeHere');
  await runRoutesCommand(['local', 'checkout-x', '--data-dir', dataDir], { write: (line) => lines.push(line), makeHere, connect });
  assert.deepEqual(asked.at(-1), { folder: path.resolve(process.cwd(), 'checkout-x'), projectId: null }, 'a folder, made absolute');
  assert.match(lines.join('\n'), /project:checkout-x → this computer[\s\S]*still goes to Host A/);
  await runRoutesCommand(['local', 'project:widgets', '--data-dir', dataDir], { write: () => {}, makeHere, connect });
  assert.deepEqual(asked.at(-1), { folder: null, projectId: 'widgets' });
  await assert.rejects(runRoutesCommand(['local', 'project:on-host', '--data-dir', dataDir], { write: () => {}, makeHere, connect }),
    (error) => error.code === 'project_on_host' && /Host A 上已经有了/.test(error.message));
  await assert.rejects(runRoutesCommand(['local', 'project:', '--data-dir', dataDir], { write: () => {}, makeHere, connect }), TypeError);
  assert.equal(asked.length, 3);
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
// Step 3a: this computer's projects are asked of its own Provider, never of the console port, which on a
// follower answers with the host's (the host's list would let a local project be followed and hidden).
const PROVIDER = 'http://127.0.0.1:65530';
const readConfig = () => ({ personal: { spaceId: 'space-synthetic', providerUrl: PROVIDER, accessToken: 'synthetic-token' } });

function ownGraph(dataDir, { projects = [], status = 200, away = false } = {}) {
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), '{"synthetic":true}');
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (away) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(status === 200 ? projects : { detail: 'synthetic failure' }),
      { status, headers: { 'content-type': 'application/json' } });
  };
  return { asked, fetchImpl };
}

test('fuli routes follow refuses a project this computer\'s own graph already has, asking its own Provider', async (t) => {
  const dataDir = dataDirectory(t);
  const { asked, fetchImpl } = ownGraph(dataDir, { projects: [{ project_id: 'widgets' }, { project_id: 'notes' }] });
  const write = () => {};
  await assert.rejects(runRoutesCommand(['follow', 'project:widgets', 'Host A', '--data-dir', dataDir], { write, readConfig, fetchImpl }),
    (error) => error.code === 'scope_has_local_data' && /already has project widgets/.test(error.message));
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith(`${PROVIDER}/v1/personal-projects?`) && asked[0].includes('personal_space_id=space-synthetic'),
    'this data directory\'s own Provider and personal space, not the console port');
  await assert.rejects(runRoutesCommand(['follow', 'default', 'Host A', '--data-dir', dataDir], { write, readConfig, fetchImpl }),
    { code: 'scope_has_local_data' }, 'a graph of its own that this computer did not prepare holds the person\'s data');
  await runRoutesCommand(['follow', 'project:gadgets', 'Host A', '--data-dir', dataDir], { write, readConfig, fetchImpl });
  const routes = openRoutes(dataDir);
  assert.deepEqual(routes.all().map((row) => row.scope).filter((scope) => scope.startsWith('project:')), ['project:gadgets']);
  routes.close();
});

test('a stopped graph is answered by what the preparation found in it; one never checked is said as that', async (t) => {
  const prepared = dataDirectory(t);
  const { fetchImpl } = ownGraph(prepared, { away: true });
  writeRecord(prepared, { state: 'ready', at: '2026-11-24T08:00:00.000Z', createdHere: true, running: false, projects: ['notes'] });
  await assert.rejects(runRoutesCommand(['follow', 'project:notes', 'Host A', '--data-dir', prepared],
    { write: () => {}, readConfig, fetchImpl }), { code: 'scope_has_local_data' });
  await runRoutesCommand(['follow', 'project:gizmos', 'Host A', '--data-dir', prepared], { write: () => {}, readConfig, fetchImpl });
  // A graph it made itself and found empty holds none of the person's data: following `global` hides nothing.
  writeRecord(prepared, { state: 'ready', at: '2026-11-24T08:00:00.000Z', createdHere: true, running: false, projects: [] });
  await runRoutesCommand(['follow', 'global', 'Host A', '--data-dir', prepared], { write: () => {}, readConfig, fetchImpl });

  const unchecked = dataDirectory(t);
  const away = ownGraph(unchecked, { away: true });
  await assert.rejects(runRoutesCommand(['follow', 'project:gizmos', 'Host A', '--data-dir', unchecked],
    { write: () => {}, readConfig, fetchImpl: away.fetchImpl }),
  (error) => error.code === 'local_fuli_not_running' && /not prepared yet/.test(error.message));
});

test('while this computer prepares its own runtime, following `global` waits for that, said as such', async (t) => {
  const dataDir = dataDirectory(t);
  const { fetchImpl } = ownGraph(dataDir, { away: true });
  writeRecord(dataDir, { state: 'preparing', pid: 4242, startedAt: '2026-11-24T08:00:00.000Z', createdHere: true });
  const holder = holdPreparationLock(dataDir);
  try {
    await assert.rejects(runRoutesCommand(['follow', 'global', 'Host A', '--data-dir', dataDir], { write: () => {}, readConfig, fetchImpl }),
      (error) => error.code === 'local_runtime_preparing' && /being prepared in the background/.test(error.message)
        && !/FULI of its own/.test(error.message));
  } finally { holder(); }
});

test('a Provider that answers with an error and settings that cannot be read are said apart', async (t) => {
  const refusing = dataDirectory(t);
  const { fetchImpl } = ownGraph(refusing, { status: 503 });
  await assert.rejects(runRoutesCommand(['follow', 'project:gizmos', 'Host A', '--data-dir', refusing],
    { write: () => {}, readConfig, fetchImpl }), (error) => error.code === 'local_fuli_refused' && /HTTP 503/.test(error.message));
  await assert.rejects(runRoutesCommand(['follow', 'project:gizmos', 'Host A', '--data-dir', refusing], { write: () => {},
    fetchImpl, readConfig: () => { throw new Error('synthetic: unreadable'); } }), { code: 'local_fuli_unreadable' });
});

// Review of #1075: a conversation begun on a follower and continued on the host carries the prefixed token.
test('the FULI that issued a token takes it back with its own name on it, and refuses another FULI\'s', () => {
  const own = 'ab'.repeat(8);
  assert.deepEqual(tokenIssuedHere({ taskContextToken: `fuli-from-${own}.fuli-task-synthetic`, workLog: 'x' }, `${own}ffff`),
    { args: { taskContextToken: 'fuli-task-synthetic', workLog: 'x' } });
  assert.deepEqual(tokenIssuedHere({ taskContextToken: `fuli-from-${'cd'.repeat(8)}.fuli-task-synthetic` }, own),
    { elsewhere: 'cd'.repeat(8) });
  assert.deepEqual(tokenIssuedHere({ taskContextToken: 'fuli-task-synthetic' }, own), { args: { taskContextToken: 'fuli-task-synthetic' } });
  assert.deepEqual(tokenIssuedHere({ taskContextToken: `fuli-from-${own}.x` }, null), { unknown: own },
    'a FULI that cannot tell its own name does not call the token another FULI\'s');
});

test('an entry answer names its issuer wherever the token appears, recovery hints included', () => {
  const entry = { taskContextToken: 'fuli-task-synthetic', entry_recovery: [{ tool: 'read_task_preferences',
    arguments: { taskContextToken: 'fuli-task-synthetic' } }] };
  const text = `${JSON.stringify(entry)}\nentry_incomplete={"reason":"entry_deadline"}`;
  const answered = answerWithIssuer({ content: [{ type: 'text', text }], structuredContent: entry }, 'ab'.repeat(32));
  const issued = `fuli-from-${'ab'.repeat(8)}.fuli-task-synthetic`;
  assert.equal(answered.structuredContent.entry_recovery[0].arguments.taskContextToken, issued);
  assert.equal(answered.content[0].text.split(issued).length - 1, 2, 'both mentions, in the text too');
  assert.doesNotMatch(answered.content[0].text.replaceAll(issued, ''), /fuli-task-synthetic/, 'never written the other way');
});

test('fuli routes scope-of takes a relative path from where it is run', async (t) => {
  const dataDir = dataDirectory(t);
  const folder = path.join(dataDir, 'notes');
  mkdirSync(folder);
  // A project this computer knows of by a route, which the host's resolver matches by the folder's name.
  const routes = openRoutes(dataDir);
  routes.set('project:notes', hostOwner(HOST.fingerprint));
  routes.close();
  const lines = [];
  // Back to where it was before the test ends: the folder is deleted after it, and Windows refuses to
  // delete the folder a process is in.
  const before = process.cwd();
  process.chdir(dataDir);
  try {
    await runRoutesCommand(['scope-of', 'notes', '--data-dir', dataDir], { write: (line) => lines.push(line) });
  } finally {
    process.chdir(before);
  }
  await runRoutesCommand(['scope-of', folder, '--data-dir', dataDir], { write: (line) => lines.push(line) });
  assert.deepEqual(lines, ['project:notes', 'project:notes'], 'the same scope as its absolute path');
});

// Routes format 2: a project this computer owns keeps the folder it was made for (make-project-local.js).
test('a routes store of version 1 is migrated, its routes kept, and a project here keeps its folder', (t) => {
  const dataDir = dataDirectory(t, { paired: false });
  mkdirSync(path.join(dataDir, 'runner'), { recursive: true });
  const file = path.join(dataDir, 'runner', 'routes.sqlite');
  const first = openFormattedDatabase(file, sqliteFormat({ ...ROUTES_FORMAT, migrations: [] }));
  first.prepare("INSERT INTO routes(scope, owner, updated_at) VALUES('global', ?, '2026-11-01T00:00:00.000Z')")
    .run(hostOwner(HOST.fingerprint));
  first.close();

  const routes = new RoutesStore(file);
  assert.deepEqual(routes.all().map((row) => [row.scope, row.owner]), [['global', hostOwner(HOST.fingerprint)]]);
  const folder = path.join(dataDir, 'widgets');
  mkdirSync(folder);
  routes.setLocalProject('project:widgets', folder);
  assert.equal(routes.all().find((row) => row.scope === 'project:widgets').folder, folder);
  assert.equal(routes.owner('project:widgets'), LOCAL_OWNER);
  assert.equal(routes.routedHere('project:widgets'), true);
  // The folder is the project's: a call there is that project's.
  assert.equal(callScope(folder, { known: [{ id: 'widgets', folder }] }), 'project:widgets');
  routes.set('project:gadgets', hostOwner(HOST.fingerprint));
  assert.equal(routes.routedHere('project:gadgets'), false);
  assert.equal(routes.routedHere('project:nowhere'), false, 'no route of its own is not this computer\'s');
  routes.close();
});

// A project made here under an id other than its folder's name (make-project-local.js projectId):
// the folder its route keeps is what says a call there is that project's, and answered here.
test('a project here whose id is not its folder\'s name is found by the folder its route keeps', (t) => {
  const dataDir = dataDirectory(t);
  const folder = path.join(dataDir, 'checkout-x');
  mkdirSync(folder);
  const routes = openRoutes(dataDir);
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  // Closed before the test ends, so before the folder's removal: Windows refuses to delete open SQLite files.
  try {
    routes.setLocalProject('project:widgets', folder);
    const known = knownProjects(store, routes);
    assert.deepEqual(known, [{ id: 'widgets', folder, local: true }]);
    const child = path.join(folder, 'src');
    mkdirSync(child);
    assert.equal(callScope(child, { known }), 'project:widgets');
    mkdirSync(path.join(child, '.git'));
    assert.equal(callScope(child, { known }), 'default');
    assert.equal(callScope(folder, { known }), 'project:widgets');
    assert.deepEqual(callDestination({ routes, store, input: { projectPath: folder } }), { to: 'local', scope: 'project:widgets' });
  } finally {
    routes.close();
    store.close();
  }
});

// Audit of #1115/#1116, item 3, for calls: a project of this computer named where the destination is not
// decided (nested, in a list, under another field's name) goes neither to the host nor here.
test('a call for the host that names a project of this computer elsewhere in it goes nowhere', (t) => {
  const dataDir = dataDirectory(t);
  const routes = openRoutes(dataDir);
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  try {
    const go = (input) => {
      const destination = callDestination({ routes, store, input });
      return destination.refused ? resultValue(destination.refused).code : destination.to;
    };
    // No project of this computer: every call goes as it did.
    assert.equal(go({ contextPersonalProjectId: 'widgets' }), 'host');
    routes.setLocalProject('project:widgets', null);
    assert.equal(go({ personalProjectId: 'widgets' }), 'local');
    assert.equal(go({ personalProjectId: 'gadgets' }), 'host');
    assert.equal(go({ queries: ['widgets are blue'] }), 'host', 'a text that only contains the id is no mention');
    for (const input of [{ contextPersonalProjectId: 'widgets' }, { personalProjectIds: ['gadgets', 'widgets'] },
      { toolName: 'search', input: { filters: { project: 'widgets' } } }, { personalProjectId: 'gadgets', related: 'widgets' }]) {
      assert.equal(go(input), 'scope_not_decidable', JSON.stringify(input));
    }
    const said = resultValue(callDestination({ routes, store, input: { personalProjectIds: ['widgets'] } }).refused);
    assert.match(said.message, /project:widgets[\s\S]*sent nowhere[\s\S]*哪里都没发/);
  } finally {
    routes.close();
    store.close();
  }
});

test('routes another FULI process holds for now say to try again, not to pair again; any other reason says what it did', () => {
  const busy = resultValue(routesUnavailableAnswer(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })));
  assert.equal(busy.code, 'routes_unavailable');
  assert.match(busy.message, /another FULI process on this computer is writing it/);
  assert.match(busy.message, /try again in a moment/);
  assert.doesNotMatch(busy.message, /runner leave|runner join/);
  const broken = resultValue(routesUnavailableAnswer(Object.assign(new Error('file is not a database'), { code: 'ERR_SQLITE_ERROR', errcode: 26 })));
  assert.equal(broken.code, 'routes_unavailable');
  assert.match(broken.message, /`fuli runner leave`, then `fuli runner join`/);
});
