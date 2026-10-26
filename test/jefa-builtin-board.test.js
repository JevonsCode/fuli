import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { installEmployeePackage } from '../src/employees/install-package.js';
import { createEmployeePackageRegistry, employeeDirectories } from '../src/employees/package-registry.js';
import { createServer } from '../src/server.js';
import { createEmployeeFixture } from '../test-support/employee-fixture.js';

// Synthetic FULI directories only; the built-in Jefa board is real.
const JEFA_TOOLS = ['read_board', 'get_task', 'create_tasks', 'update_tasks', 'answer_status_question',
  'prepare_session_title', 'report_session_title', 'get_session_title'];
const jefaManifest = JSON.parse(readFileSync(new URL('../src/employees/catalog/jefa.json', import.meta.url)));

// Cleanups run in reverse, so stores close before their directory is removed (Windows locks open files).
function cleanups(t) {
  const stack = [];
  t.after(async () => { for (const cleanup of stack.reverse()) await cleanup(); });
  return (cleanup) => stack.push(cleanup);
}

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-jefa-builtin-'));
  const defer = cleanups(t);
  defer(() => rmSync(root, { recursive: true, force: true }));
  return { root, runtimeConfigPath: join(root, 'host/graph-runtime.json'), defer };
}

async function hiredJefa(t, { runtimeConfigPath, defer } = directory(t)) {
  const app = createEmployeeFixture({ runtimeConfigPath });
  defer(() => app.close());
  await app.employees.recruit({ templateId: 'jefa' });
  const call = (tool, args, personalProjectId = 'employee-qa', extra = {}) =>
    app.employees.callTool({ templateId: 'jefa', personalProjectId, tool, arguments: args, ...extra });
  return { app, call, runtimeConfigPath, defer };
}

test('built-in Jefa is ready without an install step and keeps the other roles unchanged', async (t) => {
  const target = directory(t);
  const directories = employeeDirectories(target.runtimeConfigPath);
  const registry = createEmployeePackageRegistry(directories);
  target.defer(() => registry.close());
  assert.equal(registry.get('jefa').runtimeStatus, 'ready');
  for (const id of ['bole', 'tonborg', 'assistant']) {
    assert.equal(registry.get(id).runtimeStatus, 'not_required', id);
    assert.equal(registry.get(id).manifest.runtime, null, id);
  }
  const runtime = await registry.runtime('jefa');
  assert.deepEqual(runtime.describeTools().map((tool) => tool.name), JEFA_TOOLS);
  assert.ok(runtime.describeTools().every((tool) => jefaManifest.permissions.includes(tool.permission)));
  assert.equal(existsSync(directories.packageDirectory), false, 'nothing is installed');

  const { app, call } = await hiredJefa(t, target);
  const listed = (await app.employees.list()).templates.find((template) => template.id === 'jefa');
  assert.equal(listed.runtimeStatus, 'ready');
  assert.deepEqual((await app.employees.describeTools({ templateId: 'jefa', personalProjectId: 'employee-qa' }))
    .tools.map((tool) => tool.name), JEFA_TOOLS);
  assert.equal((await call('read_board', {})).total, 0);
  assert.equal(existsSync(join(directories.dataDirectory, 'jefa/board.sqlite')), true);
  assert.equal(existsSync(join(directories.dataDirectory, 'management.sqlite')), true);
});

test('an installed Jefa package replaces the built-in runtime, and a damaged one does not take it down', async (t) => {
  const { root, runtimeConfigPath, defer } = directory(t);
  const source = join(root, 'source');
  mkdirSync(join(source, 'runtime'), { recursive: true });
  mkdirSync(join(source, 'web'));
  writeFileSync(join(source, 'employee.json'), JSON.stringify(jefaManifest));
  writeFileSync(join(source, 'web/index.html'), '<h1>Synthetic package</h1>');
  writeFileSync(join(source, 'runtime/index.mjs'), 'export const createEmployeeRuntime = () => ({ handleHttp() {}, callTool() {}, describeTools() { return [{ name: "installed_only", permission: "board.read" }] }, close() {} });');
  installEmployeePackage({ sourceDirectory: source, runtimeConfigPath });
  const directories = employeeDirectories(runtimeConfigPath);
  const installed = createEmployeePackageRegistry(directories);
  defer(() => installed.close());
  assert.deepEqual((await installed.runtime('jefa')).describeTools().map((tool) => tool.name), ['installed_only']);

  rmSync(join(directories.packageDirectory, 'jefa/web'), { recursive: true });
  const damaged = createEmployeePackageRegistry(directories);
  defer(() => damaged.close());
  assert.equal(damaged.get('jefa').runtimeStatus, 'ready');
  assert.deepEqual((await damaged.runtime('jefa')).describeTools().map((tool) => tool.name), JEFA_TOOLS);
});

test('tasks are created once per message, read in board order and kept per project', async (t) => {
  const { call } = await hiredJefa(t);
  const created = await call('create_tasks', { messageId: 'message-1', tasks: [
    { title: 'Synthetic planned task', summary: 'Plan it', priority: 'low' },
    { title: 'Synthetic active task', status: 'active', priority: 'high', acceptanceCriteria: ['Done when shown'], tags: ['qa'] }
  ] });
  assert.equal(created.collaboration_receipt.tool, 'create_tasks');
  const [planned, active] = created.createdWorkItems;
  assert.equal(planned.status, 'planned');
  assert.equal(planned.visibility, 'private');
  assert.equal(planned.projectId, 'employee-qa');
  const retried = await call('create_tasks', { messageId: 'message-1', tasks: [
    { title: 'Synthetic planned task', summary: 'Plan it', priority: 'low' },
    { title: 'Synthetic active task', status: 'active', priority: 'high', acceptanceCriteria: ['Done when shown'], tags: ['qa'] }
  ] });
  assert.deepEqual(retried.createdWorkItems.map((item) => item.id), [planned.id, active.id]);
  await assert.rejects(call('create_tasks', { messageId: 'message-1', tasks: [{ title: 'Something else' }] }), { code: 'request_conflict' });

  const board = await call('read_board', { limit: 1 });
  assert.equal(board.total, 2);
  assert.equal(board.truncated, true);
  assert.deepEqual(board.items.map((item) => item.id), [active.id]);
  assert.equal((await call('read_board', { statuses: ['planned'] })).items[0].id, planned.id);
  const task = (await call('get_task', { workItemId: active.id })).item;
  assert.deepEqual(task.acceptanceCriteria, ['Done when shown']);
  assert.deepEqual(task.history.map((entry) => [entry.revision, entry.actor, entry.status]), [[1, 'agent', 'active']]);

  await call('read_board', {}, 'employee-qa-design').then((other) => assert.equal(other.total, 0));
  await assert.rejects(call('get_task', { workItemId: active.id }, 'employee-qa-design'), { code: 'task_not_found' });
  await assert.rejects(call('create_tasks', { messageId: 'bad', tasks: [{ title: 'x' }] }), { code: 'invalid_input' });
});

test('updates need the version they read and Agents never mark a task done', async (t) => {
  const { call } = await hiredJefa(t);
  const { createdWorkItems: [first, second] } = await call('create_tasks', { messageId: 'seed', tasks: [
    { title: 'Synthetic first task' }, { title: 'Synthetic second task' }] });
  const moved = await call('update_tasks', { requestId: 'move-1', updates: [{ id: first.id, expectedUpdatedAt: first.updatedAt, status: 'review' }] });
  const updated = moved.updatedWorkItems[0];
  assert.equal(updated.status, 'review');
  assert.ok(updated.updatedAt > first.updatedAt);
  assert.deepEqual((await call('update_tasks', { requestId: 'move-1', updates: [{ id: first.id, expectedUpdatedAt: first.updatedAt, status: 'review' }] }))
    .updatedWorkItems[0], updated, 'a retried request returns its first answer');

  // One stale update refuses the whole request; the other task is not written.
  await assert.rejects(call('update_tasks', { requestId: 'stale', updates: [
    { id: second.id, expectedUpdatedAt: second.updatedAt, title: 'Synthetic renamed task' },
    { id: first.id, expectedUpdatedAt: first.updatedAt, status: 'active' }] }), { code: 'version_conflict' });
  assert.equal((await call('get_task', { workItemId: second.id })).item.title, 'Synthetic second task');

  await assert.rejects(call('update_tasks', { requestId: 'done', updates: [{ id: first.id, expectedUpdatedAt: updated.updatedAt, status: 'done' }] }),
    { code: 'human_acceptance_required' });
  const answer = await call('answer_status_question', { workItemIds: [second.id, 'missing-task'] });
  assert.deepEqual(answer.counts, { planned: 1, active: 0, blocked: 0, review: 1, done: 0 });
  assert.deepEqual(answer.awaitingAcceptance.map((item) => item.id), [first.id]);
  assert.deepEqual(answer.requested.map((item) => item.id), [second.id]);
  assert.deepEqual(answer.missing, ['missing-task']);
});

test('session titles are proposals the client reports, never a claimed or forced rename', async (t) => {
  const { call } = await hiredJefa(t);
  const { createdWorkItems: [task] } = await call('create_tasks', { messageId: 'title-seed', tasks: [{ title: 'Synthetic title task', status: 'active' }] });
  const input = { requestId: 'title-1', sourceApplication: 'codex', sessionId: 'synthetic-session', workItemIds: [task.id],
    currentTitle: 'Synthetic first title', canRename: true };
  const prepared = await call('prepare_session_title', input);
  assert.equal(prepared.execution, 'client_required');
  assert.equal(prepared.record.proposal.status, 'ready');
  assert.equal(prepared.record.lastAppliedTitle, undefined);
  assert.equal(prepared.action.title, '🚧 Synthetic title task');
  assert.equal(prepared.action.expectedCurrentTitle, 'Synthetic first title');

  const report = { recordId: prepared.record.id, proposalId: prepared.record.proposal.id, expectedRevision: prepared.record.revision,
    outcome: 'applied', observedTitle: prepared.action.title, receiptSource: 'synthetic-adapter' };
  const reported = await call('report_session_title', report);
  assert.equal(reported.evidence, 'client_reported');
  assert.equal(reported.record.proposal.status, 'reported_applied');
  assert.equal(reported.record.lastAppliedTitle, prepared.action.title);
  await assert.rejects(call('report_session_title', report), { code: 'version_conflict' });

  // The person renamed the session after Jefa's title: it stays theirs.
  const manual = await call('prepare_session_title', { ...input, requestId: 'title-2', currentTitle: 'My own name' });
  assert.equal(manual.execution, 'locked');
  assert.equal(manual.action, null);
  assert.equal((await call('get_session_title', { sourceApplication: 'codex', sessionId: 'synthetic-session' })).record.proposal.status, 'locked');
  await assert.rejects(call('prepare_session_title', { ...input, requestId: 'title-3' }, 'employee-qa',
    { sourceApplication: 'codex', sourceSessionId: 'another-session', sourceSessionVerified: true }), { code: 'session_mismatch' });
});

test('the console board: snapshot, the person accepting done, sharing and the public projection', async (t) => {
  const { app, call, runtimeConfigPath, defer } = await hiredJefa(t);
  const { server, url } = await createServer({ app, port: 0 });
  defer(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `${url}/employee-workspaces/jefa/employee-qa/`;
  const send = (path, method, body) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { createdWorkItems: [privateTask] } = await call('create_tasks', { messageId: 'http-seed', tasks: [{ title: 'Synthetic private task', summary: 'Private detail' }] });

  const opened = await fetch(base, { redirect: 'manual' });
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), '/employees/jefa?project=employee-qa');
  assert.equal((await fetch(`${base}.well-known/agent-card.json`).then((response) => response.json())).name, 'Jefa');
  const snapshot = (await fetch(`${base}api/snapshot`).then((response) => response.json())).snapshot;
  assert.deepEqual(snapshot.projects, [{ id: 'employee-qa', publicShareEnabled: false, acceptsPublicRequests: false }]);
  assert.deepEqual(snapshot.workItems.map((item) => item.id), [privateTask.id]);

  const accepted = await send(`api/work-items/${privateTask.id}/status`, 'PATCH', { status: 'done' }).then((response) => response.json());
  assert.equal(accepted.workItem.status, 'done');
  assert.ok(accepted.workItem.acceptedAt);
  assert.equal((await call('get_task', { workItemId: privateTask.id })).item.history[0].actor, 'person');

  assert.equal((await send('api/projects/employee-qa-design/sharing', 'PATCH', { publicShareEnabled: true, acceptsPublicRequests: false })).status, 403);
  assert.equal((await send('api/projects/employee-qa/sharing', 'PATCH', { publicShareEnabled: true, acceptsPublicRequests: true })).status, 400);
  const shared = (await send('api/projects/employee-qa/sharing', 'PATCH', { publicShareEnabled: true, acceptsPublicRequests: false }).then((response) => response.json())).project;
  assert.match(shared.publicShareSlug, /^share-[a-zA-Z0-9-]{16,100}$/);
  const again = (await send('api/projects/employee-qa/sharing', 'PATCH', { publicShareEnabled: true, acceptsPublicRequests: false }).then((response) => response.json())).project;
  assert.equal(again.publicShareSlug, shared.publicShareSlug);
  const publicUrl = `${base}api/public/${shared.publicShareSlug}`;
  assert.deepEqual((await fetch(publicUrl).then((response) => response.json())).items, [], 'sharing publishes no private task');

  const created = await send('api/work-items', 'POST', { projectId: 'employee-qa', title: 'Synthetic public task', summary: 'Still private', visibility: 'public_summary', priority: 'high' });
  assert.equal(created.status, 201);
  const projection = await fetch(publicUrl).then((response) => response.json());
  assert.deepEqual(projection, { project: { id: 'employee-qa', name: '员工招募验收（测试）' }, acceptsRequests: false,
    items: [{ id: (await created.json()).workItem.id, title: 'Synthetic public task', status: 'planned', priority: 'high' }] });
  assert.equal((await fetch(`${base}api/public/share-0000000000000000000000`)).status, 404);
  assert.equal((await fetch(`${url}/employee-workspaces/jefa/employee-qa-design/api/public/${shared.publicShareSlug}`)).status, 404);

  await send('api/projects/employee-qa/sharing', 'PATCH', { publicShareEnabled: false, acceptsPublicRequests: false });
  assert.equal((await fetch(publicUrl)).status, 404, 'turning sharing off invalidates the old link');

  // The board survives a restart of the host.
  await app.close();
  const reopened = createEmployeeFixture({ runtimeConfigPath });
  defer(() => reopened.close());
  await reopened.employees.recruit({ templateId: 'jefa' });
  const board = await reopened.employees.callTool({ templateId: 'jefa', personalProjectId: 'employee-qa', tool: 'read_board', arguments: {} });
  assert.equal(board.total, 2);
  const entry = await reopened.employees.taskEntry({ personalProjectId: 'employee-qa', sourceApplication: 'other' });
  assert.equal(entry.status, 'ready');
  assert.equal(entry.managers[0].board.total, 2);
});

test('the person\'s decisions are refused from another device', async (t) => {
  const { app } = await hiredJefa(t);
  for (const [method, relativePath] of [['PATCH', '/api/projects/employee-qa/sharing'], ['PATCH', '/api/work-items/any/status'], ['POST', '/api/work-items']]) {
    const request = Object.assign(Readable.from([JSON.stringify({ status: 'done' })]), { method, socket: { remoteAddress: '192.168.1.20' } });
    let status;
    const response = { writeHead(code) { status = code; }, end() {} };
    await app.employees.handleHttp(request, response, { templateId: 'jefa', personalProjectId: 'employee-qa', relativePath });
    assert.equal(status, 403, relativePath);
  }
});
