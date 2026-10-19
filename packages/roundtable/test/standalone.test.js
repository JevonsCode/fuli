import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertionDigest, authorityFromProvider, verifyOriginProof } from '../src/peer/origin-proof.js';
import { createAgentRoundtable } from '../src/roundtable/service.js';
import { createRoundtableStore } from '../src/roundtable/store.js';
import { parseArgs, runCli, setupCommand } from '../src/standalone/cli.js';
import { createStandaloneHost } from '../src/standalone/host.js';
import { createStandaloneMcp } from '../src/standalone/mcp.js';
import { createStandaloneStore } from '../src/standalone/store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'roundtable-standalone-'));
  const folders = { asker: join(root, 'asker'), rowan: join(root, 'rowan') };
  for (const folder of Object.values(folders)) mkdirSync(join(folder, 'nested'), { recursive: true });
  const store = createStandaloneStore();
  const host = createStandaloneHost({ store });
  const asker = store.addAgent({ name: 'Asker', folder: folders.asker, clients: ['claude_code'] });
  const rowan = store.addAgent({ name: 'Rowan', folder: folders.rowan, clients: ['claude_code', 'codex'], responsibility: 'Billing' });
  return { root, folders, store, host, asker, rowan, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('each registered Agent leads its own folder, and a task speaks only for its client', async t => {
  const f = fixture(); t.after(f.close);
  assert.equal(f.host.spaceId(), f.host.spaceId());
  assert.equal(await f.host.projectForPath(join(f.folders.rowan, 'nested')), f.rowan.agentId);
  assert.equal(await f.host.projectForPath(f.root), null);
  assert.equal(await f.host.projectLeadId(f.rowan.agentId), f.rowan.agentId);
  assert.equal(await f.host.projectFolder(f.rowan.agentId), f.folders.rowan);
  assert.deepEqual((await f.host.projectTeam(f.rowan.agentId)).people.map(p => p.name), ['Rowan']);
  const token = f.store.beginTask({ agentId: f.asker.agentId, client: 'claude_code', sessionId: 's-1' });
  assert.deepEqual(await f.host.taskContext(token, 'claude_code'),
    { projectAgentId: f.asker.agentId, personalProjectId: f.asker.agentId, sourceApplication: 'claude_code', sessionId: 's-1' });
  await assert.rejects(f.host.taskContext(token, 'codex'), /not found for this client/);
  assert.equal(f.store.removeAgent(f.rowan.agentId), true);
  assert.equal(await f.host.projectLeadId(f.rowan.agentId), null);
});

test('wake authority is bound to one session, verified against it, and revocable', async t => {
  const f = fixture(); t.after(f.close);
  const task = f.store.beginTask({ agentId: f.asker.agentId, client: 'claude_code', sessionId: 's-1' });
  await assert.rejects(f.host.issueDelegation({ taskContextToken: 'unknown', client: 'claude_code', agentId: f.rowan.agentId,
    targetClient: 'claude_code', lifetimeSeconds: 60 }), /Task context/);
  await assert.rejects(f.host.issueDelegation({ taskContextToken: task, client: 'claude_code', agentId: f.asker.agentId,
    targetClient: 'codex', lifetimeSeconds: 60 }), /unavailable in this client/);
  const { token } = await f.host.issueDelegation({ taskContextToken: task, client: 'claude_code', agentId: f.rowan.agentId,
    targetClient: 'claude_code', lifetimeSeconds: 60 });
  await f.host.sealDelegation({ token, sessionId: 'woken-1' });
  await assert.rejects(f.host.sealDelegation({ token, sessionId: 'woken-2' }), /another session/);
  assert.deepEqual(await f.host.verifyDelegation({ token, sessionId: 'woken-2' }), { redeemed: false, memoryResultCount: 0 });
  assert.deepEqual(await f.host.verifyDelegation({ token, sessionId: 'woken-1' }), { redeemed: true, memoryResultCount: 0 });
  await f.host.revokeDelegation({ token });
  assert.equal((await f.host.verifyDelegation({ token, sessionId: 'woken-1' })).redeemed, false);
});

test('a remote attempt gets authority once, and signed origins verify with the paired authority', async t => {
  const f = fixture(); t.after(f.close);
  const remote = { projectId: f.rowan.agentId, agentId: f.rowan.agentId, targetClient: 'claude_code', lifetimeSeconds: 60,
    originNode: 'n'.repeat(64), originMessageId: 'm-1', originAttemptId: 'a-1' };
  assert.ok((await f.host.issueRemoteDelegation(remote)).token);
  await assert.rejects(f.host.issueRemoteDelegation(remote), { code: 'attempt_already_granted', status: 409 });
  await assert.rejects(f.host.issueRemoteDelegation({ ...remote, projectId: f.asker.agentId }), /only ask the project lead/);

  const task = f.store.beginTask({ agentId: f.asker.agentId, client: 'claude_code', sessionId: 's-1' });
  const assertion = { protocol: 'peer/1', messageId: 'msg-1', threadId: 't-1', body: 'question',
    from: { node: 'f'.repeat(64), agentId: f.asker.agentId, name: 'Asker', client: 'claude_code' },
    to: { node: 'n'.repeat(64), bindingId: 'binding', agentId: 'remote-lead' }, conversation: 'auto', depth: 1,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const issued = await f.host.issueRemoteOrigin({ taskContextToken: task, client: 'claude_code', messageId: 'msg-1',
    digest: assertionDigest(assertion), targetNode: assertion.to.node, bindingId: 'binding', expiresAt: assertion.expiresAt });
  assert.equal(issued.agent_id, f.asker.agentId);
  const authority = authorityFromProvider(await f.host.remoteOriginAuthority());
  const scope = verifyOriginProof({ ...assertion, origin: issued.proof }, authority);
  assert.deepEqual([scope.agentId, scope.projectId, scope.spaceId], [f.asker.agentId, f.asker.agentId, f.host.spaceId()]);
  await assert.rejects(f.host.issueRemoteOrigin({ taskContextToken: task, client: 'claude_code', messageId: 'msg-1',
    digest: 'other', targetNode: assertion.to.node, bindingId: 'binding', expiresAt: assertion.expiresAt }), /different remote ask/);
});

test('an Agent asks another one, which is woken in its own folder on a bound session', async t => {
  const f = fixture(); t.after(f.close);
  const woken = [];
  const roundtable = createAgentRoundtable({ host: f.host, openStore: () => createRoundtableStore(), clientAvailable: () => true,
    wake: async input => { woken.push(input); await input.onSession?.('woken-session'); return { body: 'make ship', sessionId: 'woken-session' }; } });
  t.after(() => roundtable.close());
  const { tools } = createStandaloneMcp({ roundtable, host: f.host, store: f.store, client: 'claude_code', cwd: join(f.folders.asker, 'nested') });
  const found = await tools.find_agents.run({ query: 'rowan' });
  assert.deepEqual(found.agents.map(agent => agent.name), ['Rowan']);
  const answer = await tools.message_agent.run({ to: 'Rowan', body: 'What deploys staging?' });
  assert.equal(answer.status, 'answered');
  assert.equal(answer.reply, 'make ship');
  assert.equal(woken[0].cwd, f.folders.rowan);
  assert.equal(woken[0].client, 'claude_code');

  const stranger = createStandaloneMcp({ roundtable, host: f.host, store: f.store, client: 'claude_code', cwd: f.root });
  await assert.rejects(stranger.tools.message_agent.run({ to: 'Rowan', body: 'Hi' }), { code: 'agent_required' });
  const wokenSession = createStandaloneMcp({ roundtable, host: f.host, store: f.store, client: 'claude_code', cwd: f.folders.rowan, woken: true });
  await assert.rejects(wokenSession.tools.message_agent.run({ to: 'Asker', body: 'Hi' }), { code: 'read_only' });
});

test('the CLI registers, lists and removes Agents in its home and prints client setup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'roundtable-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const lines = [];
  const out = line => lines.push(line);
  assert.deepEqual(parseArgs(['agent', 'list', '--json', '--home', 'h']), { positional: ['agent', 'list'], options: { json: true, home: 'h' } });
  assert.equal(await runCli(['agent', 'add', '--name', 'Rowan', '--folder', root, '--clients', 'claude_code', '--home', home], { out }), 0);
  await assert.rejects(runCli(['agent', 'add', '--name', 'X', '--folder', join(root, 'missing'), '--clients', 'codex', '--home', home], { out }), /existing folder/);
  await assert.rejects(runCli(['agent', 'add', '--name', 'X', '--folder', root, '--clients', 'cursor', '--home', home], { out }), /--clients/);
  lines.length = 0;
  assert.equal(await runCli(['agent', 'list', '--json', '--home', home], { out }), 0);
  assert.deepEqual(JSON.parse(lines[0]).map(agent => agent.profile.name), ['Rowan']);
  assert.equal(await runCli(['agent', 'remove', 'Rowan', '--home', home], { out }), 0);
  assert.equal(await runCli(['setup', '--client', 'codex'], { out }), 0);
  const [program, args] = setupCommand('claude_code');
  assert.equal(program, 'claude');
  assert.deepEqual(args.slice(0, 5), ['mcp', 'add', '--scope', 'user', 'fuli-roundtable']);
  assert.deepEqual(args.slice(-3), ['mcp', '--client', 'claude_code']);
});

test('serve answers the owner peer controls on loopback, and peer share --agent names the Agent and its folder', async t => {
  const { openStandalone } = await import('../src/standalone/runtime.js');
  const { startStandaloneServe, serveAddress } = await import('../src/standalone/serve.js');
  const root = mkdtempSync(join(tmpdir(), 'roundtable-serve-'));
  const home = join(root, 'home');
  const standalone = openStandalone({ home, env: {} });
  standalone.store.addAgent({ name: 'Rowan', folder: root, clients: ['claude_code'] });
  const serving = await startStandaloneServe({ standalone, port: 0 });
  t.after(async () => { await serving.close(); await standalone.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(serveAddress(home), `http://127.0.0.1:${serving.port}`);
  const lines = [];
  assert.equal(await runCli(['peer', 'status', '--home', home], { out: line => lines.push(line) }), 0);
  assert.equal(lines[0], 'LAN roundtable (Beta): off.');
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { requests.push([String(url), init?.body ? JSON.parse(init.body) : null]);
    return new Response(JSON.stringify({ role: null, addresses: [] }), { status: 200 }); };
  t.after(() => { globalThis.fetch = realFetch; });
  await runCli(['peer', 'share', '--agent', 'Rowan', '--clients', 'claude_code', '--home', home], { out: () => {} });
  const [url, body] = requests.at(-1);
  assert.match(url, /\/api\/peer\/shares$/);
  const rowan = standalone.store.agents()[0];
  assert.deepEqual(body, { shares: [{ projectId: rowan.agentId, clients: ['claude_code'], workingDirectory: root }] });
});
