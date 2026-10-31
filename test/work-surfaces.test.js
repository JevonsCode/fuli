import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { createAgentServices } from '../src/agent-services/port.js';
import { createAgentWorkflows } from '../src/agent-workflows/port.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { inspectLocalStores } from '../src/data-format/local-stores.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleWorkSurfacesRequest } from '../src/http/work-surfaces-api-router.js';
import { createWorkSurfaces } from '../src/work-surfaces/port.js';
import { workSurfaceNames, workSurfaceSources } from '../src/work-surfaces/sources.js';

// rec#11 D-85: every FLA's work surfaces in one table, 全部暂停 and 恢复.
// Synthetic stores in temporary directories and fake owners only: no process
// is started, inspected or ended, and no port is opened.

const SPACE = 'space-a';
const PERSON = Object.freeze({ type: 'person' });

// Stores opened in the directory close before it is removed (Windows refuses an open file).
function temporary(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const opened = [];
  t.after(() => { for (const store of opened) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, opened };
}

// A fake kind whose items are switched in memory; calls are recorded.
function fakeKind(items, calls, { pausable = true, failPause = null } = {}) {
  return {
    async list() {
      return items.map((item) => ({ kind: item.kind, id: item.id, name: item.name, agentId: item.agentId,
        personalProjectId: item.personalProjectId ?? null, state: item.on ? 'running' : 'stopped', on: item.on,
        pausable, changedAt: null, resume: { mode: 'managed' } }));
    },
    async pause(row, actor) {
      calls.push(['pause', row.id, actor.type]);
      if (row.id === failPause) throw Object.assign(new Error('synthetic refusal'), { code: 'synthetic_refused' });
      items.find((item) => item.id === row.id).on = false;
      return { status: 'paused' };
    },
    async resume(row, actor) {
      calls.push(['resume', row.id, actor.type, row.resume.mode]);
      items.find((item) => item.id === row.id).on = true;
      return { status: 'resumed' };
    }
  };
}

const NAMES = async () => ({
  agents: new Map([['fla-a', { name: 'Ada North', personalProjectId: 'garden' }], ['fla-b', { name: 'Bo South', personalProjectId: 'orchard' }]]),
  projects: new Map([['garden', 'Synthetic Garden'], ['orchard', 'Synthetic Orchard']])
});

function surfacesIn(t, { services, apps, failPause, names = NAMES, workflowsFail = false } = {}) {
  const { directory, opened } = temporary(t, 'fuli-work-surfaces-');
  const calls = [];
  services ??= [
    { kind: 'agent_service', id: 'svc-1', name: 'Synthetic dev server', agentId: 'fla-a', on: true },
    { kind: 'agent_service', id: 'svc-2', name: 'Synthetic docs', agentId: 'fla-b', on: false }];
  apps ??= [{ kind: 'agent_app', id: 'app-1', name: 'Synthetic board', agentId: 'fla-b', on: true }];
  let tick = 0;
  const surfaces = createWorkSurfaces({ path: join(directory, 'work-surfaces.sqlite'), names,
    now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++)), newId: (() => { let n = 0; return () => `pause-${++n}`; })(),
    sources: {
      agent_service: fakeKind(services, calls, { failPause }),
      agent_app: fakeKind(apps, calls),
      workflow: { list: async () => {
        if (workflowsFail) throw Object.assign(new Error('synthetic'), { code: 'synthetic_down' });
        return [{ kind: 'workflow', id: 'wf-1', name: 'Synthetic release check', agentId: 'fla-a', personalProjectId: 'garden',
          state: 'active', on: null, pausable: false, changedAt: null }];
      } }
    } });
  opened.push(surfaces);
  return { surfaces, calls, services, apps, directory, opened };
}

test('the table names each item\'s FLA and project, and every filter narrows it', async (t) => {
  const { surfaces } = surfacesIn(t);
  const { items, partial } = await surfaces.list({ personalSpaceId: SPACE, filter: {} });
  assert.equal(partial, false);
  assert.deepEqual(items.map((row) => [row.kind, row.id, row.agentName, row.personalProjectId, row.projectName, row.state]), [
    ['agent_service', 'svc-1', 'Ada North', 'garden', 'Synthetic Garden', 'running'],
    ['agent_service', 'svc-2', 'Bo South', 'orchard', 'Synthetic Orchard', 'stopped'],
    ['agent_app', 'app-1', 'Bo South', 'orchard', 'Synthetic Orchard', 'running'],
    ['workflow', 'wf-1', 'Ada North', 'garden', 'Synthetic Garden', 'active']]);
  assert.equal(Object.hasOwn(items[0], 'resume'), false, 'resume details stay inside FULI');
  const ids = async (filter) => (await surfaces.list({ personalSpaceId: SPACE, filter })).items.map(({ id }) => id);
  assert.deepEqual(await ids({ agentId: 'fla-b' }), ['svc-2', 'app-1']);
  assert.deepEqual(await ids({ personalProjectId: 'garden' }), ['svc-1', 'wf-1']);
  assert.deepEqual(await ids({ kind: 'agent_app' }), ['app-1']);
  assert.deepEqual(await ids({ state: 'running' }), ['svc-1', 'app-1']);
  assert.deepEqual(await ids({ q: 'orchard' }), ['svc-2', 'app-1'], 'q finds whose it is and which project');
  assert.deepEqual(await ids({ q: 'ADA', kind: 'agent_service' }), ['svc-1']);
  await assert.rejects(surfaces.list({ personalSpaceId: SPACE, filter: { kind: 'printer' } }), { code: 'invalid_input' });
});

test('pause snapshots first, turns off only what is on, and resume reopens exactly those', async (t) => {
  const { surfaces, calls, services, apps } = surfacesIn(t);
  const paused = await surfaces.pause({ personalSpaceId: SPACE, filter: {}, actor: PERSON });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.skipped, 1, 'the workflow has no off switch');
  assert.deepEqual(paused.results.map(({ id, wasOn, result }) => [id, wasOn, result]),
    [['svc-1', true, 'paused'], ['svc-2', false, 'already_off'], ['app-1', true, 'paused']]);
  assert.deepEqual([...services, ...apps].map(({ on }) => on), [false, false, false]);

  const resumed = await surfaces.resume({ personalSpaceId: SPACE, pauseId: paused.pauseId, actor: PERSON });
  assert.deepEqual(resumed.results.map(({ id, result }) => [id, result]),
    [['svc-1', 'resumed'], ['svc-2', 'left_off'], ['app-1', 'resumed']]);
  assert.deepEqual([...services, ...apps].map(({ on }) => on), [true, false, true], 'svc-2 was off before and stays off');
  assert.deepEqual(calls, [['pause', 'svc-1', 'person'], ['pause', 'app-1', 'person'],
    ['resume', 'svc-1', 'person', 'managed'], ['resume', 'app-1', 'person', 'managed']]);

  const again = await surfaces.resume({ personalSpaceId: SPACE, actor: PERSON });
  assert.equal(again.pauseId, paused.pauseId, 'without pauseId, the latest pause');
  assert.deepEqual(again.results.map(({ result }) => result), ['already_on', 'left_off', 'already_on']);
  assert.equal(calls.length, 4, 'nothing already on is started twice');
});

test('a filtered pause covers only its matches; a failure is reported and the rest go on', async (t) => {
  const { surfaces, services, apps } = surfacesIn(t, { failPause: 'svc-1' });
  const paused = await surfaces.pause({ personalSpaceId: SPACE, filter: { agentId: 'fla-a' }, actor: PERSON });
  assert.deepEqual(paused.results.map(({ id, result, detail }) => [id, result, detail?.code ?? null]),
    [['svc-1', 'failed', 'synthetic_refused']]);
  assert.equal(apps[0].on, true, 'another FLA\'s app is not touched');
  assert.equal(services[0].on, true);
  const none = await surfaces.pause({ personalSpaceId: SPACE, filter: { kind: 'workflow' }, actor: PERSON });
  assert.deepEqual([none.status, none.pauseId, none.skipped], ['nothing_to_pause', null, 1]);
  await assert.rejects(surfaces.resume({ personalSpaceId: 'space-b', pauseId: paused.pauseId, actor: PERSON }),
    { code: 'pause_not_found', status: 404 });
});

test('an item gone by resume time is reported, and an owner that cannot be read is not guessed', async (t) => {
  const services = [{ kind: 'agent_service', id: 'svc-1', name: 'Synthetic server', agentId: 'fla-a', on: true }];
  const { surfaces } = surfacesIn(t, { services, apps: [] });
  const paused = await surfaces.pause({ personalSpaceId: SPACE, filter: {}, actor: PERSON });
  services.length = 0;
  const resumed = await surfaces.resume({ personalSpaceId: SPACE, pauseId: paused.pauseId, actor: PERSON });
  assert.deepEqual(resumed.results.map(({ id, result }) => [id, result]), [['svc-1', 'gone']]);

  const { surfaces: degraded } = surfacesIn(t, { workflowsFail: true, names: async () => { throw new Error('graph down'); } });
  const listed = await degraded.list({ personalSpaceId: SPACE, filter: {} });
  assert.equal(listed.partial, true);
  assert.deepEqual(listed.unavailable, [{ kind: 'names', code: 'unavailable' }, { kind: 'workflow', code: 'synthetic_down' }]);
  assert.deepEqual([listed.items.length, listed.items[0].agentName], [3, null], 'local rows are still shown');
});

test('every pause and resume is recorded with who did it, and the records are immutable', async (t) => {
  const { surfaces, directory, opened } = surfacesIn(t);
  const paused = await surfaces.pause({ personalSpaceId: SPACE, filter: { kind: 'agent_service' },
    actor: { type: 'agent', agentId: 'fla-b', sessionId: 'session-b' } });
  await surfaces.resume({ personalSpaceId: SPACE, pauseId: paused.pauseId, actor: PERSON });
  const [pause] = surfaces.history({ personalSpaceId: SPACE }).pauses;
  assert.deepEqual([pause.pauseId, pause.filter.kind], [paused.pauseId, 'agent_service']);
  assert.deepEqual(pause.items.map(({ id, wasOn }) => [id, wasOn]), [['svc-1', true], ['svc-2', false]]);
  assert.equal(Object.hasOwn(pause.items[0], 'resume'), false);
  assert.deepEqual(pause.actions.map(({ action, actor }) => [action, actor.type, actor.agentId]),
    [['pause', 'agent', 'fla-b'], ['resume', 'person', null]]);
  assert.deepEqual(pause.actions[1].results.map(({ result }) => result), ['resumed', 'left_off']);
  assert.throws(() => surfaces.history({ personalSpaceId: SPACE, limit: 0 }), { code: 'invalid_input' });

  const database = new DatabaseSync(join(directory, 'work-surfaces.sqlite'));
  opened.push(database);
  for (const sql of ['UPDATE work_surface_pause_items SET was_on = 0', 'DELETE FROM work_surface_actions',
    'DELETE FROM work_surface_pauses']) {
    assert.throws(() => database.exec(sql), /immutable/, sql);
  }
});

test('a missing store reads as no pauses and is never created by a read', async (t) => {
  const { surfaces, directory } = surfacesIn(t);
  assert.deepEqual(surfaces.history({ personalSpaceId: SPACE }), { pauses: [] });
  await surfaces.list({ personalSpaceId: SPACE, filter: {} });
  assert.equal(inspectLocalStores(directory).find(({ label }) => label === 'work-surfaces.sqlite').state, 'absent');
  await surfaces.pause({ personalSpaceId: SPACE, filter: {}, actor: PERSON });
  assert.equal(inspectLocalStores(directory).find(({ label }) => label === 'work-surfaces.sqlite').state, 'current');
});

// The real owners' ports over synthetic stores; the process inspector and the
// Agent app runner are fakes, so nothing is started or ended.
function ownersIn(t) {
  const { directory, opened } = temporary(t, 'fuli-work-surface-owners-');
  const alive = new Set([4101]);
  const terminated = [];
  const inspector = {
    inspect: async (pids) => new Map(pids.filter((pid) => alive.has(pid))
      .map((pid) => [pid, { identity: `test:${pid}`, executable: '/synthetic/node', commandLine: 'node synthetic' }])),
    terminate: async (record) => { terminated.push(record.pid); alive.delete(record.pid); return 'stopped'; }
  };
  let tick = 0;
  const agentServices = createAgentServices({ path: join(directory, 'agent-services.sqlite'), inspector,
    probe: async () => 'not_checked', now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++)) });
  const agentWorkflows = createAgentWorkflows({ path: join(directory, 'agent-workflows.sqlite') });
  opened.push(agentServices, agentWorkflows);
  const appCalls = [];
  const appState = { instance: { instanceId: 'ins-1', mode: 'managed', state: 'running', startedAt: '2026-11-01T00:00:00Z', stoppedAt: null } };
  const agentApps = {
    list: ({ personalSpaceId }) => ({ apps: personalSpaceId !== SPACE ? [] : [
      { appId: 'app-board', agentId: 'fla-b', name: 'board', title: 'Synthetic board', type: 'service', status: 'active',
        version: '1.0.0', run: { status: 'ready' }, instance: appState.instance, lastUsedAt: null },
      { appId: 'app-gone', agentId: 'fla-b', name: 'gone', title: 'Deleted app', status: 'deleted', run: { status: 'run_refused' }, instance: null }] }),
    stop: async (input) => { appCalls.push(['stop', input]); appState.instance = { ...appState.instance, state: 'sealed', stoppedAt: 'x' };
      return { status: 'sealed' }; },
    start: async (input) => { appCalls.push(['start', input]); appState.instance = { ...appState.instance, instanceId: 'ins-2', state: 'running', stoppedAt: null };
      return { status: 'running', instanceId: 'ins-2' }; }
  };
  const app = {
    config: { personal: { spaceId: SPACE } }, agentServices, agentWorkflows, agentApps,
    listProjectAgentTasks: async (input) => {
      assert.equal(input.agentId, null, 'every FLA\'s tasks');
      return [{ taskId: 'task-1', personalProjectId: 'garden', title: 'Plant the synthetic beds', status: 'running',
        updatedAt: '2026-11-01T01:00:00Z', events: [], participants: [
          { agentId: 'fla-a', role: 'lead', status: 'running' }, { agentId: 'fla-b', role: 'collaborator', status: 'queued' }] },
      { taskId: 'task-2', personalProjectId: 'garden', title: 'Cancelled', status: 'cancelled', participants: [{ agentId: 'fla-a' }] }];
    },
    listProjectAgents: async () => [{ agentId: 'fla-a', personalProjectId: 'garden', profile: { name: 'Ada North' } },
      { agentId: 'fla-b', personalProjectId: 'orchard', profile: { name: 'Bo South' } }],
    listPersonalProjects: async () => [{ project_id: 'garden', profile: { name: 'Synthetic Garden' } },
      { project_id: 'orchard', profile: { name: 'Synthetic Orchard' } }]
  };
  const owner = { personalSpaceId: SPACE, agentId: 'fla-a', projectId: 'garden', client: 'codex', sessionId: 'session-a' };
  const tokens = [];
  app.taskContextRegistry = { context: async (token, client) => {
    tokens.push([token, client]);
    return { sessionId: 'session-a', projectAgentId: 'fla-a', sourceApplication: 'codex' };
  } };
  const surfaces = createWorkSurfaces({ path: join(directory, 'work-surfaces.sqlite'), sources: workSurfaceSources(app),
    names: (personalSpaceId) => workSurfaceNames(app, personalSpaceId) });
  opened.push(surfaces);
  app.workSurfaces = surfaces;
  return { app, owner, agentServices, agentWorkflows, appCalls, terminated, surfaces, tokens };
}

test('each kind comes from its owner, and pause goes through each owner\'s own stop', async (t) => {
  const { app, owner, agentServices, agentWorkflows, appCalls, terminated, surfaces } = ownersIn(t);
  const { service } = await agentServices.register(owner, { purpose: 'Synthetic dev server', pid: 4101, command: 'npm run dev',
    address: 'localhost:5173' });
  await agentServices.register(owner, { purpose: 'Synthetic page without a process', address: 'localhost:9' });
  await agentServices.register({ ...owner, personalSpaceId: 'space-b' }, { purpose: 'Another space' });
  agentWorkflows.propose({ personalSpaceId: SPACE, agentId: 'fla-a', personalProjectId: 'garden' },
    { name: 'Synthetic release check', purpose: 'Check a build', steps: [{ title: 'Run tests' }], source: 'agent' });

  const { items } = await surfaces.list({ personalSpaceId: SPACE, filter: {} });
  assert.deepEqual(items.map((row) => [row.kind, row.name, row.agentName, row.projectName, row.state, row.on, row.pausable]), [
    // The services port lists the newest first.
    ['agent_service', 'Synthetic page without a process', 'Ada North', 'Synthetic Garden', 'unknown', false, false],
    ['agent_service', 'Synthetic dev server', 'Ada North', 'Synthetic Garden', 'running', true, true],
    ['agent_app', 'Synthetic board', 'Bo South', 'Synthetic Orchard', 'running', true, true],
    ['workflow', 'Synthetic release check', 'Ada North', 'Synthetic Garden', 'proposed', null, false],
    ['workbench', 'Plant the synthetic beds', 'Ada North', 'Synthetic Garden', 'running', null, false],
    ['workbench', 'Plant the synthetic beds', 'Bo South', 'Synthetic Garden', 'queued', null, false]]);

  const paused = await callAgentTool(app, 'pause_work_surfaces', { taskContextToken: 'fuli-task-synthetic' });
  assert.deepEqual(paused.results.map(({ kind, result }) => [kind, result]), [['agent_service', 'paused'], ['agent_app', 'paused']]);
  assert.equal(paused.skipped, 4, 'the PID-less service, the workflow and both workbench shares');
  assert.deepEqual(terminated, [4101], 'the recorded PID, through the services port\'s identity check');
  assert.deepEqual(appCalls, [['stop', { appId: 'app-board' }]]);
  const stopped = agentServices.log({ serviceId: service.serviceId }).entries[0];
  assert.deepEqual([stopped.action, stopped.actor], ['stopped', 'agent']);

  const resumed = await callAgentTool(app, 'resume_work_surfaces', { taskContextToken: 'fuli-task-synthetic', pauseId: paused.pauseId });
  assert.deepEqual(resumed.results.map(({ kind, result, detail }) => [kind, result, detail]), [
    ['agent_service', 'restart_required', { command: 'npm run dev', address: 'localhost:5173' }],
    ['agent_app', 'resumed', { instanceId: 'ins-2' }]]);
  assert.deepEqual(appCalls.at(-1), ['start', { appId: 'app-board', mode: 'managed' }]);
});

test('the Agent tools take who acted from the task token; their kinds match the owners', async (t) => {
  const { app, tokens } = ownersIn(t);
  await assert.rejects(callAgentTool(app, 'pause_work_surfaces', {}), { code: 'invalid_input' });
  const listed = await callAgentTool(app, 'list_work_surfaces', { kind: 'agent_app' });
  assert.deepEqual(listed.items.map(({ id }) => id), ['app-board']);
  await callAgentTool(app, 'pause_work_surfaces', { taskContextToken: 'fuli-task-synthetic', kind: 'agent_app' });
  const [pause] = app.workSurfaces.history({ personalSpaceId: SPACE }).pauses;
  assert.deepEqual(pause.actions[0].actor, { type: 'agent', agentId: 'fla-a', sessionId: 'session-a' });
  assert.deepEqual(tokens, [['fuli-task-synthetic', 'other']]);

  const tools = new Map(listAgentTools().map((tool) => [tool.name, tool]));
  assert.deepEqual(tools.get('list_work_surfaces').inputSchema.properties.kind.enum.sort(),
    Object.keys(workSurfaceSources(app)).sort());
  const catalog = agentInterfaceCatalog();
  const byRoute = new Map(catalog.uiMutationParity.map((entry) => [entry.route, entry]));
  assert.equal(byRoute.get('POST /api/work-surfaces/pauses').toolName, 'pause_work_surfaces');
  assert.equal(byRoute.get('POST /api/work-surfaces/pauses/:pauseId/resume').toolName, 'resume_work_surfaces');
});

function request(method, body, remoteAddress) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  return Object.assign(stream, { method, headers: { 'content-type': 'application/json' }, socket: { remoteAddress } });
}

async function api(app, method, path, body = null, remoteAddress = '127.0.0.1') {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    sent.handled = await handleWorkSurfacesRequest({ request: request(method, body, remoteAddress), response,
      url: new URL(`http://127.0.0.1${path}`), app });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('the console routes list, pause and resume on this computer only', async (t) => {
  const { surfaces, services } = surfacesIn(t);
  const app = { config: { personal: { spaceId: SPACE } }, workSurfaces: surfaces };
  assert.equal((await api(app, 'GET', '/api/work-surfaces', null, '192.0.2.10')).body.code, 'local_user_only');
  assert.deepEqual((await api(app, 'GET', '/api/work-surfaces?agentId=fla-a')).body.items.map(({ id }) => id), ['svc-1', 'wf-1']);
  assert.equal((await api(app, 'POST', '/api/work-surfaces/pauses', { kind: 'agent_service' }, '192.0.2.10')).body.code, 'local_user_only');
  const paused = (await api(app, 'POST', '/api/work-surfaces/pauses', { kind: 'agent_service' })).body;
  assert.deepEqual(paused.results.map(({ result }) => result), ['paused', 'already_off']);
  assert.equal(services[0].on, false);
  const resumed = (await api(app, 'POST', '/api/work-surfaces/pauses/latest/resume')).body;
  assert.deepEqual([resumed.pauseId, services[0].on], [paused.pauseId, true]);
  const history = (await api(app, 'GET', '/api/work-surfaces/pauses?limit=5')).body;
  assert.deepEqual(history.pauses[0].actions.map(({ action, actor }) => [action, actor.type]), [['pause', 'person'], ['resume', 'person']]);
  assert.equal((await api(app, 'GET', '/api/work-surfaces/pauses?limit=x')).status, 400);
  assert.equal((await api(app, 'POST', '/api/work-surfaces/pauses/missing/resume')).status, 404);
  assert.equal((await api(app, 'DELETE', '/api/work-surfaces')).status, 405);
  assert.equal((await api(app, 'GET', '/api/agent-services')).handled, false);
  assert.equal((await api({ config: app.config }, 'GET', '/api/work-surfaces')).status, 503);
});
