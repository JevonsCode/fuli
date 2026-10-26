import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { createTrustedRunner } from '../src/agent-apps/trusted-runner.js';
import { createAgentServices } from '../src/agent-services/port.js';
import { AgentServiceStore } from '../src/agent-services/store.js';
import { handleAgentServicesRequest } from '../src/http/agent-services-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { appRegistry, until, verifiedApp } from '../test-support/agent-app-hosts.js';

// rec#11 D-71 服务管理. Every process started, probed or ended here is a
// synthetic child of this test; no real FULI data directory or console is used.

const OWNER = Object.freeze({ personalSpaceId: 'space-a', agentId: 'fla-builder', projectId: 'project-a',
  client: 'claude_code', sessionId: 'session-a' });
const OTHER = Object.freeze({ ...OWNER, agentId: 'fla-other', sessionId: 'session-b' });

function servicesIn(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-agent-services-'));
  const path = join(directory, 'agent-services.sqlite');
  const services = createAgentServices({ path, ...options });
  t.after(() => { services.close(); rmSync(directory, { recursive: true, force: true }); });
  return { services, path };
}

// A synthetic long-running process this test owns; ended when the test ends.
function syntheticServer(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  });
  return { child, exited, started: new Promise((resolve) => child.once('spawn', resolve)) };
}

async function listener(t) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, address: `http://127.0.0.1:${server.address().port}/` };
}

const actions = (services, serviceId) => services.log({ serviceId }).entries.map(({ action }) => action).reverse();
const listed = async (services, serviceId) => (await services.list()).services.find((item) => item.serviceId === serviceId);

test('an Agent registers and updates its own service, and the person stops it after confirming its PID', async (t) => {
  const { services } = servicesIn(t);
  const { child, exited, started } = syntheticServer(t);
  await started;
  const registered = await services.register(OWNER, { purpose: 'Synthetic dev server', address: 'localhost:9',
    pid: child.pid, command: 'node synthetic' });
  assert.equal(registered.status, 'registered');
  const { serviceId } = registered.service;
  assert.equal((await services.register(OWNER, { purpose: 'again', pid: child.pid })).status, 'already_registered');

  await assert.rejects(services.update(OTHER, { serviceId, purpose: 'not mine' }), { code: 'not_service_owner' });
  assert.equal((await services.update(OWNER, { serviceId, purpose: 'Synthetic preview server' })).status, 'updated');

  const live = await listed(services, serviceId);
  assert.deepEqual([live.purpose, live.agentId, live.projectId, live.client, live.sessionId],
    ['Synthetic preview server', 'fla-builder', 'project-a', 'claude_code', 'session-a']);
  assert.deepEqual([live.live.state, live.live.process], ['running', 'alive']);
  assert.match(live.commandLine ?? '', /setInterval/);

  await assert.rejects(services.stop({ serviceId, pid: child.pid + 1 }), { code: 'pid_not_confirmed' });
  const stopped = await services.stop({ serviceId, pid: child.pid });
  assert.equal(stopped.status, 'stopped');
  await exited;
  assert.deepEqual([stopped.service.state, stopped.service.stopReason], ['stopped', 'stopped_by_person']);
  assert.deepEqual(actions(services, serviceId), ['registered', 'updated', 'stopped']);
  assert.equal(services.log({ serviceId }).entries[0].actor, 'person');
});

test('a PID that no longer runs is refused at registration, and an Agent records its own stop', async (t) => {
  const { services } = servicesIn(t);
  const { child, exited, started } = syntheticServer(t);
  await started;
  const { service } = await services.register(OWNER, { purpose: 'Synthetic worker', pid: child.pid });
  child.kill();
  await exited;
  await assert.rejects(services.register(OWNER, { purpose: 'gone', pid: child.pid }), { code: 'invalid_input' });
  const reported = await services.update(OWNER, { serviceId: service.serviceId, state: 'stopped' });
  assert.deepEqual([reported.status, reported.service.state], ['stopped', 'stopped']);
  assert.deepEqual(actions(services, service.serviceId), ['registered', 'stopped']);
});

test('liveness checks the recorded process and the port, and records a service that stopped by itself', async (t) => {
  const { services } = servicesIn(t);
  const { child, exited, started } = syntheticServer(t);
  await started;
  const { server, address } = await listener(t);
  const withProcess = (await services.register(OWNER, { purpose: 'Synthetic API', address, pid: child.pid })).service;
  const portOnly = (await services.register(OWNER, { purpose: 'Synthetic docs', address })).service;
  const elsewhere = (await services.register(OWNER, { purpose: 'Remote', address: 'https://example.invalid:8443' })).service;

  let recorded = await listed(services, withProcess.serviceId);
  assert.deepEqual([recorded.live.state, recorded.live.process, recorded.live.port], ['running', 'alive', 'open']);
  assert.deepEqual((await listed(services, portOnly.serviceId)).live, { state: 'running', process: null, port: 'open' });
  assert.deepEqual((await listed(services, elsewhere.serviceId)).live, { state: 'unknown', process: null, port: 'not_checked' });

  child.kill();
  await exited;
  await new Promise((resolve) => server.close(resolve));
  recorded = await listed(services, withProcess.serviceId);
  assert.deepEqual([recorded.live.state, recorded.live.process, recorded.state, recorded.stopReason],
    ['stopped', 'gone', 'stopped', 'not_running']);
  assert.equal((await listed(services, portOnly.serviceId)).live.state, 'stopped');
  assert.deepEqual(actions(services, withProcess.serviceId), ['registered', 'found_stopped']);
  await services.list();
  assert.deepEqual(actions(services, withProcess.serviceId), ['registered', 'found_stopped'], 'recorded once');
});

test('FULI refuses to stop a PID whose process identity changed, and leaves it running', async (t) => {
  const { services, path } = servicesIn(t);
  const { child, started } = syntheticServer(t);
  await started;
  const { service } = await services.register(OWNER, { purpose: 'Synthetic server', pid: child.pid });
  // The record now names another process under the same PID (a reused PID).
  const store = new AgentServiceStore(path);
  store.update(service.serviceId, { pidIdentity: `${process.platform}:0` });
  store.close();

  await assert.rejects(services.stop({ serviceId: service.serviceId, pid: child.pid }), { code: 'process_changed', status: 409 });
  assert.equal(child.exitCode === null && child.signalCode === null, true, 'the process was not ended');
  assert.deepEqual(actions(services, service.serviceId), ['registered', 'stop_refused']);
  assert.equal((await listed(services, service.serviceId)).live.process, 'replaced');
});

test('a log is appended to, cleared by the person, and a record is deleted with its log', async (t) => {
  const { services } = servicesIn(t);
  const { service } = await services.register(OWNER, { purpose: 'Synthetic page', address: '127.0.0.1:9' });
  await services.update(OWNER, { serviceId: service.serviceId, address: '127.0.0.1:10' });
  assert.deepEqual(actions(services, service.serviceId), ['registered', 'updated']);
  assert.equal(services.clearLog({ serviceId: service.serviceId }).entries, 2);
  assert.deepEqual(services.log({ serviceId: service.serviceId }).entries, []);
  assert.equal(services.remove({ serviceId: service.serviceId }).status, 'deleted');
  assert.throws(() => services.log({ serviceId: service.serviceId }), { code: 'service_not_found' });
  assert.deepEqual((await services.list()).services, []);
});

test('report_agent_service takes the owner from the task its token names, never from arguments', async (t) => {
  const { services } = servicesIn(t, { inspector: { inspect: async () => new Map(), terminate: async () => 'mismatch' },
    probe: async () => 'not_checked' });
  const tokens = [];
  const app = {
    config: { personal: { spaceId: 'space-a' } },
    getAgentAccessPolicy: () => ({ enabled: true }), getCapturePolicy: () => ({ enabled: true }),
    agentServices: services,
    taskContextRegistry: { context: async (token, sourceApplication) => {
      tokens.push([token, sourceApplication]);
      return { sessionId: 'session-a', personalProjectId: 'project-a', projectAgentId: 'fla-builder', sourceApplication: 'codex' };
    } }
  };
  const registered = await callAgentTool(app, 'report_agent_service', { action: 'register', taskContextToken: 'fuli-task-synthetic',
    purpose: 'Synthetic dev server', address: 'http://localhost:5173', command: 'npm run dev', agentId: 'someone-else' });
  assert.equal(registered.status, 'registered');
  assert.equal(Object.hasOwn(registered.service, 'commandLine'), false);
  const [record] = (await services.list()).services;
  assert.deepEqual([record.agentId, record.projectId, record.client, record.sessionId, record.kind],
    ['fla-builder', 'project-a', 'codex', 'session-a', 'agent_service']);
  const updated = await callAgentTool(app, 'report_agent_service', { action: 'update', taskContextToken: 'fuli-task-synthetic',
    serviceId: record.serviceId, state: 'stopped' });
  assert.equal(updated.service.state, 'stopped');
  assert.deepEqual(tokens[0], ['fuli-task-synthetic', 'other']);
});

test('an Agent app workbench is recorded by its runner: start, output tail without the app token, stop', async (t) => {
  const registry = appRegistry(t);
  const children = [];
  const runner = createTrustedRunner({
    spawnProcess: (...args) => { const child = spawn(...args); children.push(child); return child; },
    hostIdentity: { identify: async (pid) => `test-child:${pid}`, probe: async () => 'unknown' }
  });
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const inspected = [];
  let host;
  const { services } = servicesIn(t, {
    inspector: { inspect: async (pids) => { inspected.push(...pids); return new Map(pids.map((pid) => [pid,
      { identity: `fake:${pid}`, executable: process.execPath, commandLine: 'node synthetic' }])); } },
    probe: async () => 'not_checked',
    stopWorkbench: (appId) => host.service.stop({ appId })
  });
  host = registry.host({ pid: 101, runner, serviceLog: services.workbench });
  const script = "console.log('synthetic ready ' + process.env.FULI_APP_TOKEN); setInterval(() => {}, 1000);\n";
  const app = await verifiedApp(host, { runtime: { apiVersion: 1, entry: 'service/main.js' } },
    [{ path: 'service/main.js', content: script }]);
  const started = await host.service.start({ appId: app.appId });
  const serviceId = `workbench-${started.instanceId}`;

  await until(() => services.log({ serviceId }).liveOutput?.includes('synthetic ready'), 'the output tail');
  assert.match(services.log({ serviceId }).liveOutput, /synthetic ready \[redacted\]/);
  const [record] = (await services.list()).services;
  assert.deepEqual([record.kind, record.agentId, record.appId, record.client, record.state, record.live.state],
    ['workbench', 'agent-jvs', app.appId, 'fuli', 'running', 'running']);
  assert.equal(inspected.includes(record.pid), true);

  assert.equal((await services.stop({ serviceId, pid: record.pid })).status, 'stopped');
  const ended = (await services.list()).services[0];
  assert.deepEqual([ended.state, ended.stopReason], ['stopped', 'stopped']);
  const entries = services.log({ serviceId }).entries;
  assert.deepEqual(entries.map(({ action }) => action).reverse(), ['started', 'stop_requested', 'output', 'stopped']);
  const output = entries.find(({ action }) => action === 'output').detail.text;
  assert.match(output, /synthetic ready \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(entries), /fla_[A-Za-z0-9_-]{16,}/, 'no app token is kept');
});

function request(method, body, remoteAddress) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  return Object.assign(stream, { method, headers: { 'content-type': 'application/json' }, socket: { remoteAddress } });
}

async function api(app, method, path, body = null, remoteAddress = '127.0.0.1') {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    sent.handled = await handleAgentServicesRequest({ request: request(method, body, remoteAddress), response,
      url: new URL(`http://127.0.0.1${path}`), app });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('the console routes answer on this computer only, and a stop needs the confirmed PID', async (t) => {
  const { services } = servicesIn(t, { inspector: { inspect: async () => new Map(), terminate: async () => 'mismatch' },
    probe: async () => 'not_checked' });
  const app = { agentServices: services };
  const { service } = await services.register(OWNER, { purpose: 'Synthetic page', address: '127.0.0.1:9' });
  const base = `/api/agent-services/${service.serviceId}`;
  assert.equal((await api(app, 'GET', '/api/agent-services', null, '192.0.2.10')).body.code, 'local_user_only');
  assert.equal((await api(app, 'GET', '/api/agent-services')).body.services.length, 1);
  assert.deepEqual((await api(app, 'GET', `${base}/log`)).body.entries.map(({ action }) => action), ['registered']);
  assert.equal((await api(app, 'POST', `${base}/stop`, {})).status, 400);
  assert.equal((await api(app, 'POST', `${base}/stop`, { pid: 7 })).status, 409, 'no recorded process');
  assert.equal((await api(app, 'DELETE', `${base}/log`)).body.status, 'cleared');
  assert.equal((await api(app, 'DELETE', base)).body.status, 'deleted');
  assert.equal((await api(app, 'GET', `${base}/log`)).status, 404);
  assert.equal((await api(app, 'PUT', base)).status, 405);
  assert.equal((await api({}, 'GET', '/api/agent-services')).status, 503);
});
