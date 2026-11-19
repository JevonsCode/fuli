import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { diagnosticEventLog } from '../src/diagnostics/event-log.js';
import { createIssueReport } from '../src/diagnostics/issue-report.js';
import { observeMcpDiagnostics } from '../src/diagnostics/mcp-configuration.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { personalHumanReviewChannel } from '../src/graphiti/human-review-channel.js';
import { runStdio } from '../src/mcp/runtime.js';
import { listenFetchableServer } from '../src/server/listen.js';

async function localLog(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-issue-log-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return diagnosticEventLog(directory);
}

const secret = 'private-customer';
const client = (props = {}) => ({ id: 'codex', sourceApplication: 'codex', detected: true, status: 'connected',
  components: { mcp: 'current' }, restartSessions: 0, ...props });
const configuration = clients => ({ available: true, clients, customClients: [] });
const issueReport = options => createIssueReport(options)();

test('stdio startup and console graph failures are captured beside the runtime config', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-issue-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  await writeFile(runtimeConfigPath, '{invalid json');
  await assert.rejects(runStdio({ runtimeConfigPath, sourceApplication: 'codex' }));
  const send = personalHumanReviewChannel(directory, {
    readText: () => JSON.stringify({ personal: { providerUrl: 'http://127.0.0.1', accessToken: secret } }),
    fetchImpl: async () => Response.json({ detail: { code: 'data_format_read_only', message: secret } }, { status: 503 })
  });
  assert.equal((await send(`/v1/spaces/${secret}/graph`, {})).status, 503);
  const events = diagnosticEventLog(directory).read().events;
  assert.deepEqual(events.map(e => [e.operation, e.code]), [
    ['start.codex', 'mcp_runtime_config_invalid'], ['POST spaces', 'data_format_read_only']
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private-customer|invalid json/);
});

test('a recovered 401 is silent, while a timeout and an unavailable network have distinct codes', async t => {
  const log = await localLog(t);
  const client = new GraphitiProviderClient({ baseUrl: 'http://127.0.0.1', accessToken: 'old',
    diagnosticEvents: log, refreshAccessToken: () => 'renewed', fetchImpl: async (_url, options) =>
      Response.json({}, { status: options.headers.authorization === 'Bearer old' ? 401 : 200 }) });
  await client.listSpaces();
  assert.equal(log.read().events.length, 0);
  client.requestTimeoutMs = 15;
  client.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(client.listSpaces(), { code: 'provider_timeout' });
  client.fetch = async () => { throw new TypeError(secret); };
  await assert.rejects(client.listSpaces(), { code: 'provider_unavailable' });
  assert.deepEqual(log.read().events.map(e => [e.code, e.httpStatus]), [
    ['provider_timeout', undefined], ['provider_unavailable', undefined]
  ]);
});

test('a slow MCP scan leaves the events immediately available and its completed result for the next refresh', async t => {
  const log = await localLog(t);
  let resolveScan;
  let runs = 0;
  const generate = createIssueReport({ log, observeClients: () => {
    runs++;
    return new Promise(resolve => { resolveScan = resolve; });
  }, liveProcesses: () => [], scanWaitMs: 5 });
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
  const report = await generate();
  assert.match(report, /No failure events recorded/);
  assert.match(report, /scan still pending/);
  resolveScan(configuration([client()]));
  assert.match(await generate(), /codex: config=connected/);
  assert.equal(runs, 1);
});

test('older events share only supported operations, metadata and status, newest 30 first', async t => {
  const log = await localLog(t);
  for (let i = 0; i < 31; i++) log.record({ component: 'http', operation: `POST /api/knowledge/${secret}`,
    outcome: 'failed', code: 'private_customer', reason: `HTTP 502: ${secret}@example.test`, correlationId: secret });
  const report = await issueReport({ log, observeClients: () => configuration([]), liveProcesses: () => [] });
  assert.match(report, /30 \/ 31 retained/);
  assert.equal(report.match(/POST \/api\/knowledge \| unclassified \| HTTP 502/g)?.length, 30);
  assert.doesNotMatch(report, /private[-_]customer|example.test/);
});

test('real database requests record the final failure with a public operation and status', async t => {
  const log = await localLog(t);
  let status = 503;
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: { code: 'private_customer', message: secret } }));
  });
  await listenFetchableServer(server, 0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const providerUrl = `http://127.0.0.1:${server.address().port}`;
  const app = new FederatedGraphApplication({ personal: { providerUrl, accessToken: secret }, workspaces: [
    { providerUrl, protocol: 'fuli-workspace-v1', accessToken: secret }
  ] }, { diagnosticEvents: log });
  await assert.rejects(app.personal.graph(secret, 12, secret), { status: 503 });
  status = 403;
  await assert.rejects(app.workspaces.get(providerUrl).client.listSpaces(), { status: 403 });
  status = 200;
  await app.personal.health();
  const events = log.read().events;
  assert.deepEqual(events.map(({ component, operation, code, httpStatus, outcome }) =>
    [component, operation, code, httpStatus, outcome]), [
    ['provider', 'GET spaces', 'provider_http_5xx', 503, 'failed'],
    ['provider', 'GET workspaces', 'provider_error', 403, 'refused']
  ]);
  const report = await issueReport({ log, observeClients: () => configuration([]), liveProcesses: () => [] });
  assert.match(report, /GET spaces.*provider_http_5xx.*HTTP 503/);
  assert.match(report, /GET workspaces.*provider_error.*HTTP 403/);
  assert.doesNotMatch(JSON.stringify(events) + report, /private[-_]customer|127\.0\.0\.1/);
});

test('an upgrade and concurrent MCP versions can be diagnosed without sharing names, paths or sessions', async t => {
  const log = await localLog(t);
  const broken = client({ status: 'changed', components: { mcp: 'outdated' }, restartSessions: 2,
    configuredInstall: { path: `C:\\Users\\${secret}\\app-0.27.15`, exists: false, version: null } });
  let result = configuration([broken]);
  result.customClients = [{ id: secret, label: secret }];
  const observeClients = observeMcpDiagnostics(() => Promise.resolve(result), log);
  const liveProcesses = () => ['0.27.15', '0.27.15', '0.27.17'].map(version =>
    ({ sourceApplication: 'codex', version, pid: 123456, sessionIds: [secret] }));
  const report = await issueReport({ log, observeClients, liveProcesses });
  assert.match(report, /codex.*outdated.*target=missing.*restart_pending=2/);
  assert.match(report, /target_slot=0\.27\.15/);
  assert.match(report, /codex.*0\.27\.15.*count=2/);
  assert.match(report, /codex.*0\.27\.17.*count=1/);
  assert.match(report, /mcp_target_missing/);
  await observeClients();
  assert.equal(log.read().events.length, 1);
  result = configuration([client()]);
  await observeClients();
  result = configuration([broken]);
  await observeClients();
  assert.equal(log.read().events.length, 2);
  assert.doesNotMatch(report, /private-customer|123456|Users/);
});

test('missing or unreadable sources stay distinct from an empty log and from healthy configuration', async t => {
  const log = await localLog(t);
  const offline = () => { throw new Error(secret); };
  const observeClients = observeMcpDiagnostics(offline, log);
  await assert.rejects(observeClients(), new RegExp(secret));
  const partial = await issueReport({ log, observeClients, liveProcesses: offline });
  assert.match(partial, /Configuration: unavailable/);
  assert.match(partial, /Registered MCP processes: unavailable/);
  assert.match(partial, /mcp_detection_unavailable/);
  assert.doesNotMatch(partial, new RegExp(secret));
  assert.equal(log.read().events.length, 1);
  const emptyLog = await localLog(t);
  const empty = await issueReport({ log: emptyLog, observeClients: () => configuration([]), liveProcesses: () => [] });
  assert.match(empty, /No failure events recorded/);
  const unreadable = await issueReport({ log: { read: offline }, observeClients: () => configuration([]), liveProcesses: () => [] });
  assert.match(unreadable, /Event log: unavailable/);
  assert.doesNotMatch(unreadable, /No failure events recorded|private-customer/);
});
