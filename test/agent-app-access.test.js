import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { agentAppRoot, createAgentAppService } from '../src/agent-apps/service.js';
import { handleAgentAppApiRequest } from '../src/http/agent-app-api-router.js';
import { runAppCommand } from '../src/cli/app-command.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { createServer } from '../src/server.js';
import { reachableModules } from '../test-support/module-graph.js';
import { closeServer, requestJson } from '../test-support/server.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const MANIFEST = Object.freeze({
  schemaVersion: 1, name: 'dispatch-log', version: '1.0.0', title: 'Dispatch log',
  description: 'Synthetic fixture page that lists dispatched replies.',
  permissions: ['fuli.search_knowledge_graph'],
  runtime: { apiVersion: 1, webRoot: 'web' },
  data: { scope: 'app', format: 1 }
});
const FILES = Object.freeze([{ path: 'web/index.html', content: '<h1>Synthetic dispatch log</h1>' }]);
const LOCAL_ROUTES = [
  'POST /api/agent-apps/:appId/approve',
  'POST /api/agent-apps/:appId/disable',
  'POST /api/agent-apps/:appId/rollback',
  'POST /api/agent-apps/:appId/delete-code',
  'POST /api/agent-apps/:appId/data-deletion',
  'POST /api/agent-apps/:appId/delete-data'
];

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-agent-app-access-'));
  const runtimeConfigPath = join(dataDir, 'graph-runtime.json');
  const service = createAgentAppService({
    root: agentAppRoot(runtimeConfigPath),
    providerIdentity: 'http://127.0.0.1:65530',
    resolveOwner: async (owner) => owner,
    toolNames: () => listAgentTools().map(({ name }) => name)
  });
  // The registry database must close before Windows lets its directory go.
  t.after(() => {
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { runtimeConfigPath, service, app: { getAgentAccessPolicy: () => ({ enabled: true }), agentApps: service } };
}

const submission = (manifest = {}) => ({
  personalSpaceId: 'space-a', agentId: 'agent-jvs', manifest: { ...MANIFEST, ...manifest }, files: FILES
});

test('the Agent tool submits and lists app versions but can never approve or change them', async (t) => {
  const { app, service } = fixture(t);
  const appTools = listAgentTools().filter(({ name }) => name.includes('agent_app'));
  assert.deepEqual(appTools.map(({ name }) => name), ['submit_agent_app_version', 'list_agent_apps']);
  const schema = jsonSchemaToZod(appTools[0].inputSchema);
  assert.equal(schema.safeParse(submission()).success, true);
  assert.equal(schema.safeParse({ ...submission(), approve: true }).success, false);

  const submitted = await callAgentTool(app, 'submit_agent_app_version', submission());
  assert.equal(submitted.status, 'pending');
  await assert.rejects(async () => callAgentTool(app, 'submit_agent_app_version',
    submission({ version: '1.0.1', approved: true })), { code: 'invalid_manifest' });
  await assert.rejects(async () => callAgentTool(app, 'submit_agent_app_version',
    submission({ version: '1.0.2', permissions: ['fuli.submit_agent_app_version'] })), { code: 'permission_unavailable' });
  for (const name of ['approve_agent_app', 'disable_agent_app', 'rollback_agent_app', 'delete_agent_app']) {
    assert.throws(() => callAgentTool(app, name, { appId: submitted.appId }), /Unknown agent tool/);
  }

  const detail = await callAgentTool(app, 'list_agent_apps', { appId: submitted.appId });
  assert.equal(detail.status, 'pending');
  assert.equal(detail.versions[0].approval, null);
  assert.equal((await callAgentTool(app, 'list_agent_apps', { agentId: 'agent-jvs' })).apps.length, 1);
  assert.equal(service.read({ appId: submitted.appId }).status, 'pending');

  const byRoute = new Map(agentInterfaceCatalog().uiMutationParity.map((entry) => [entry.route, entry]));
  for (const route of LOCAL_ROUTES) {
    assert.equal(byRoute.get(route)?.access, 'local_user_only', route);
    assert.match(byRoute.get(route).reason, /local/i, route);
  }
});

test('an Agent on the chat profile submits through fuli_call and cannot reach an approval', async (t) => {
  const { app, service } = fixture(t);
  const server = createMcpServer(app, { env: {}, toolProfile: 'chat', registerResources: false });
  const client = new Client({ name: 'agent-app-chat-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const discovered = await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'submit_agent_app_version' } });
  assert.equal(discovered.isError, undefined);
  const submitted = await client.callTool({ name: 'fuli_call',
    arguments: { toolName: 'submit_agent_app_version', input: submission() } });
  assert.equal(submitted.isError, undefined);
  assert.equal(submitted.structuredContent.status, 'pending');
  const { appId } = submitted.structuredContent;
  for (const toolName of ['approve_agent_app', 'rollback_agent_app']) {
    const refused = await client.callTool({ name: 'fuli_call', arguments: { toolName, input: { appId } } });
    assert.equal(refused.isError, true, toolName);
  }
  const listed = await client.callTool({ name: 'fuli_call', arguments: { toolName: 'list_agent_apps', input: { appId } } });
  assert.equal(listed.structuredContent.versions[0].approval, null);
  assert.equal(service.read({ appId }).status, 'pending');
});

test('the local HTTP API lists apps and accepts management writes only from this computer', async (t) => {
  const { app, service } = fixture(t);
  const submitted = await service.submit(submission());
  const { server, url } = await createServer({ app: { agentApps: service }, port: 0 });
  t.after(() => closeServer(server));

  const listed = await requestJson(`${url}/api/agent-apps?agentId=agent-jvs`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.apps.map(({ appId, status }) => ({ appId, status })),
    [{ appId: submitted.appId, status: 'pending' }]);
  const wrongDigest = await requestJson(`${url}/api/agent-apps/${submitted.appId}/approve`,
    { method: 'POST', body: { version: '1.0.0', digest: '0'.repeat(64) } });
  assert.equal(wrongDigest.status, 409);
  assert.equal(wrongDigest.body.code, 'digest_mismatch');

  const remote = await routeDirectly(app, 'POST', `/api/agent-apps/${submitted.appId}/approve`,
    { version: '1.0.0', digest: submitted.digest }, '192.168.1.20');
  assert.equal(remote.status, 403);
  assert.equal(service.read({ appId: submitted.appId }).status, 'pending');

  const approved = await requestJson(`${url}/api/agent-apps/${submitted.appId}/approve`,
    { method: 'POST', body: { version: '1.0.0', digest: submitted.digest } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'active');
  const detail = await requestJson(`${url}/api/agent-apps/${submitted.appId}`);
  assert.equal(detail.body.versions[0].approval.entrypoint, 'http');
  assert.equal(detail.body.versions[0].approval.presence, 'unverified');
  const overview = await requestJson(`${url}/api/agent-apps`);
  assert.deepEqual([overview.body.apps[0].approval.entrypoint, overview.body.apps[0].approval.presence], ['http', 'unverified']);

  const disabled = await requestJson(`${url}/api/agent-apps/${submitted.appId}/disable`, { method: 'POST', body: {} });
  assert.equal(disabled.body.status, 'disabled');
  const step1 = await requestJson(`${url}/api/agent-apps/${submitted.appId}/delete-code`, { method: 'POST', body: {} });
  assert.equal(step1.body.status, 'code_deleted');
  const offer = await requestJson(`${url}/api/agent-apps/${submitted.appId}/data-deletion`, { method: 'POST', body: {} });
  assert.equal(offer.body.confirm, submitted.appId);
  const unconfirmed = await requestJson(`${url}/api/agent-apps/${submitted.appId}/delete-data`,
    { method: 'POST', body: { ticket: offer.body.ticket } });
  assert.equal(unconfirmed.status, 409);
  const deleted = await requestJson(`${url}/api/agent-apps/${submitted.appId}/delete-data`,
    { method: 'POST', body: { ticket: offer.body.ticket, confirm: submitted.appId } });
  assert.equal(deleted.body.status, 'deleted');
});

test('fuli app approve refuses non-interactive callers and records a presence-checked CLI approval', async (t) => {
  const { runtimeConfigPath, service } = fixture(t);
  const submitted = await service.submit({
    ...submission({ resident: true, runtime: { apiVersion: 1, entry: 'service/main.js', webRoot: 'web' } }),
    files: [...FILES, { path: 'service/main.js', content: 'export const synthetic = true;\n' }]
  });
  const args = ['approve', submitted.appId, '1.0.0', '--runtime-config', runtimeConfigPath];
  const lines = [];
  const print = (line) => lines.push(line);

  await assert.rejects(runAppCommand(args, { interactive: false, confirm: async () => true, print }),
    /interactive terminal/);
  const piped = spawnSync(process.execPath, [CLI, 'app', ...args], { env: {}, encoding: 'utf8', timeout: 10_000 });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /interactive terminal/);
  // A fake presence port: it proves the CLI's state machine, never a real Windows Hello.
  const asked = [];
  const presence = { kind: 'hello', verify: async (challenge) => { asked.push(challenge); return { verified: true }; } };
  const prompts = [];
  await runAppCommand(args, { interactive: true, print, platform: 'win32', presence, confirm: async (question) => {
    prompts.push(question);
    return prompts.length === 1;
  } });
  assert.match(prompts[0], new RegExp(submitted.digest));
  assert.match(prompts[0], /fuli\.search_knowledge_graph/);
  assert.match(prompts[0], /Hello 返回用户验证结果，不签署 challenge/);
  assert.match(prompts[0], /不在安全桌面/);
  assert.doesNotMatch(prompts.join('\n'), /过不了 Hello|cannot pass Hello/i);
  assert.match(prompts[1], /resident/i);
  assert.equal(asked.length, 0, 'every confirmation comes before the one presence check');
  assert.equal(service.read({ appId: submitted.appId }).status, 'pending');

  await runAppCommand(args, { interactive: true, print, platform: 'win32', presence, confirm: async () => true });
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, new RegExp(`${submitted.digest}[\\s\\S]*Resident service yes[\\s\\S]*${asked[0].challengeId}`));
  const approved = service.read({ appId: submitted.appId });
  assert.equal(approved.status, 'active');
  assert.equal(approved.versions[0].approval.entrypoint, 'cli');
  assert.equal(approved.versions[0].approval.presence, 'hello');
  assert.equal(approved.versions[0].approval.verification, 'os_user_verified');
  assert.equal(approved.versions[0].approval.challengeId, asked[0].challengeId);
  assert.equal(JSON.parse(lines.at(-1)).run.status, 'run_refused');

  await runAppCommand(['disable', submitted.appId, '--runtime-config', runtimeConfigPath], { interactive: false, print });
  assert.equal(service.read({ appId: submitted.appId }).status, 'disabled');
});

// rec#7 D-28.8: the normal MCP and fuli_call paths, and the console, cannot reach
// the presence-checked decisions or the presence port. This proves the call
// graph only: an Agent's shell can still start `fuli app approve`, and then the
// Hello dialog needs the local user.
test('only the CLI reaches the presence-checked approval and the presence port', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const presenceOnly = ['src/agent-apps/verified-decisions.js', 'src/presence/port.js', 'src/presence/windows-hello.js',
    'src/presence/windows-helper-pin.js'].map((path) => join(root, path));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js', 'src/server.js']) {
    const modules = reachableModules(join(root, entry));
    assert.deepEqual(presenceOnly.filter((path) => modules.has(path)), [], entry);
  }
  const cli = reachableModules(join(root, 'src/cli.js'));
  assert.deepEqual(presenceOnly.filter((path) => !cli.has(path)), []);
  const importers = [...cli].filter((path) => path.startsWith(join(root, 'src'))
    && /from '\.\.\/agent-apps\/verified-decisions\.js'|from '\.\.\/presence\/port\.js'/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(importers, [join(root, 'src/cli/app-command.js')]);
});

// D-28.10: the Add-Type probe is a developer tool behind FULI_DEV_WIN_PROBE=1, never in the shipped path.
test('the shipped presence path never compiles a Windows probe at run time', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const shipped = [...reachableModules(join(root, 'src/cli.js')), ...reachableModules(join(root, 'src/server.js'))];
  assert.deepEqual(shipped.filter((path) => readFileSync(path, 'utf8').includes('FULI_DEV_WIN_PROBE')), []);
  const presence = [...reachableModules(join(root, 'src/presence/port.js')),
    ...reachableModules(join(root, 'src/agent-apps/verified-decisions.js'))];
  assert.deepEqual(presence.filter((path) => /Add-Type|powershell/i.test(readFileSync(path, 'utf8'))), []);
  const probe = readFileSync(join(root, 'scripts/dev-win-hello-probe.ps1'), 'utf8');
  assert.match(probe, /\$env:FULI_DEV_WIN_PROBE -ne '1'/);
  const packaged = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files;
  assert.equal(packaged.some((entry) => entry.startsWith('scripts')), false);
});

async function routeDirectly(app, method, path, body, remoteAddress) {
  const request = Object.assign((async function* () { yield Buffer.from(JSON.stringify(body)); })(), {
    method, url: path, headers: { host: '127.0.0.1', 'content-type': 'application/json' }, socket: { remoteAddress }
  });
  const response = { status: null, body: null,
    writeHead(status) { this.status = status; }, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  await handleAgentAppApiRequest({ request, response, url: new URL(path, 'http://127.0.0.1'), app });
  return response;
}
