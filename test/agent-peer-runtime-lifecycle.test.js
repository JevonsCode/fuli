import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPeerPort } from '../src/agent-peer/peer-port.js';
import { createPeerRuntime } from '../src/agent-peer/peer-runtime.js';
import { canonicalJson, sha256Hex } from '../src/agent-peer/protocol.js';
import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';

// Signs exactly like the FULI Provider does: the private key stays in here.
function signingAuthority() {
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ format: 'jwk' }).x;
  return { keyId: sha256Hex(Buffer.from(publicKey, 'base64url')).slice(0, 32), publicKey, privateKey: key.privateKey };
}

async function device(label, { tamper = null, wakeAnswer = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), `fuli-peer-${label}-`));
  const spaceId = `${label}-space`;
  const projectId = `${label}-project`;
  const leadId = `${label}-lead`;
  const authority = signingAuthority();
  const calls = { grants: [], wakes: [], origins: [] };
  const personal = {
    getRemoteOriginAuthority: async () => ({ algorithm: 'Ed25519', key_id: authority.keyId, public_key: authority.publicKey }),
    issueRemoteAgentOrigin: async (input) => {
      calls.origins.push(input);
      const claims = { version: 'fuli-remote-origin/1', key_id: authority.keyId, space_id: spaceId, project_id: projectId,
        agent_id: leadId, task_hash: sha256Hex(input.task_context_token), message_id: input.message_id, digest: input.digest,
        target_node: input.target_node, binding_id: input.binding_id, issued_at: new Date().toISOString(),
        expires_at: input.expires_at };
      const payload = Buffer.from(canonicalJson(claims));
      let proof = { payload: payload.toString('base64url'), signature: sign(null, payload, authority.privateKey).toString('base64url') };
      if (tamper) proof = tamper(proof, claims);
      return { agent_id: leadId, agent_name: 'Lead', proof };
    },
    issueRemoteAgentDelegation: async (input) => { calls.grants.push(input); return { token: `grant-${calls.grants.length}` }; },
    verifyAgentDelegation: async () => ({ redeemed: true }),
    revokeAgentDelegation: async () => ({}),
    recentAgentSessions: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: leadId, team_member_agent_ids: [] }),
    listProjectAgents: async () => [{ agent_id: leadId, profile: { status: 'active', name: `${label} lead` },
      assignments: [{ personal_project_id: projectId, status: 'active' }] }],
    listPersonalProjects: async () => [{ project_id: projectId, name: `${label} project` }],
  };
  const app = {
    config: { personal: { spaceId } },
    personal,
    listProjectAgents: async () => [{ agentId: leadId, profile: { name: `${label} lead`, status: 'active', allowedClients: ['codex'] } }],
    taskContextRegistry: { context: async () => ({ projectAgentId: leadId, personalProjectId: projectId,
      sourceApplication: 'codex', sessionId: `${label}-session` }) },
  };
  app.peer = createPeerPort({ dataDir, provider: personal, spaceId: () => spaceId, statusPollMs: 50 });
  app.roundtable = createAgentRoundtable({ app, openStore: () => createRoundtableStore(), clientAvailable: () => true,
    wake: async (input) => { calls.wakes.push(input); return wakeAnswer ? wakeAnswer(input) : { body: `${label} answers`, sessionId: `${label}-woken` }; } });
  const folder = join(dataDir, 'project-folder');
  const runtime = createPeerRuntime({ app, port: app.peer, allowLoopback: true, claimWaitMs: 300, interfaces: () => ({}),
    resolveFolder: (path) => ({ personalProjectId: path === folder ? projectId : null }) });
  return { app, runtime, calls, projectId, folder, close: async () => {
    await runtime.close(); app.roundtable.close(); app.peer.close(); await rm(dataDir, { recursive: true, force: true });
  } };
}

async function pair(coordinator, member, { folder = true } = {}) {
  await coordinator.runtime.enableCoordinator({ host: '127.0.0.1', port: 0, name: 'Coordinator' });
  const { invitation } = coordinator.runtime.createInvitation();
  await member.runtime.join({ invitation, name: 'Member' });
  await member.runtime.setShares({ shares: [{ projectId: member.projectId, clients: ['codex'],
    ...(folder ? { workingDirectory: member.folder } : {}) }] });
}

async function remoteAddress(app) {
  for (let index = 0; index < 50; index += 1) {
    const found = await app.roundtable.findAgents({});
    if (found.remoteAgents?.length) return found.remoteAgents[0].address;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('No remote Agent appeared');
}


test('owner disable withdraws member sharing and rejects new asks', { timeout: 15000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    const address = await remoteAddress(alpha.app);
    const local = await beta.runtime.disable();
    assert.equal(local.role, null);
    assert.deepEqual(local.shares, []);
    const found = await alpha.app.peer.remoteAgents();
    assert.equal(found.agents.length, 0);
    await assert.rejects(alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: address, body: 'Synthetic ask after the owner disabled sharing', wait: false }), { code: 'agent_not_shared' });
  } finally { await alpha.close(); await beta.close(); }
});

test('a sender reconnects to the current coordinator address after re-enable', { timeout: 15000 }, async () => {
  const alpha = await device('alpha');
  try {
    const first = await alpha.runtime.enableCoordinator({ host: '127.0.0.1', port: 0, name: 'Coordinator' });
    assert.deepEqual(await alpha.app.peer.remoteAgents(), { agents: [] });
    await alpha.runtime.disable();
    const second = await alpha.runtime.enableCoordinator({ host: '127.0.0.1', port: 0, name: 'Coordinator' });
    assert.equal(second.coordinator.listening, true);
    assert.notEqual(second.coordinator.url, first.coordinator.url);
    const found = await alpha.app.peer.remoteAgents();
    assert.deepEqual(found, { agents: [] });
  } finally { await alpha.close(); }
});


import { runProcess } from '../src/agent-roundtable/wake.js';
import { setTimeout as delay } from 'node:timers/promises';

test('withdrawing sharing stops managed execution and reports cancellation', { timeout: 15000 }, async () => {
  const started = Promise.withResolvers();
  const alpha = await device('alpha');
  const beta = await device('beta', { wakeAnswer: input => runProcess(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'], { cwd: input.cwd, env: {}, input: '', timeoutMs: 30000, signal: input.signal,
      onSpawn: () => { input.onSpawn(); started.resolve(input.signal); } }) });
  try {
    await mkdir(beta.folder);
    await pair(alpha, beta);
    const ask = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: await remoteAddress(alpha.app), body: 'Synthetic in-flight request', wait: false });
    const signal = await started.promise;
    const removed = await beta.runtime.setShares({ shares: [] });
    assert.deepEqual(removed.shares, []);
    assert.equal((await alpha.app.peer.remoteAgents()).agents.length, 0);
    assert.equal(signal.aborted, true, 'share removal stops its managed execution');
    const status = await alpha.app.roundtable.messageStatus({ taskContextToken: 'alpha-task', sourceApplication: 'codex', messageId: ask.messageId });
    assert.equal(status.status, 'cancelled');
    await beta.runtime.disable();
    assert.equal(signal.aborted, true);
    const cancelled = await alpha.app.roundtable.messageStatus({ taskContextToken: 'alpha-task', sourceApplication: 'codex', messageId: ask.messageId });
    assert.equal(cancelled.status, 'cancelled');
  } finally { await alpha.close(); await beta.close(); }
});

test('Provider project profile names are used in the local and remote directory', { timeout: 15000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    beta.app.personal.listPersonalProjects = async () => [{ project_id: beta.projectId, personal_space_id: 'beta-space',
      scope_type: 'registered', profile: { name: 'Synthetic Friendly Project' }, publication_key: 'synthetic-publication' }];
    await pair(alpha, beta);
    const local = await beta.runtime.status();
    const remote = await alpha.app.peer.remoteAgents();
    assert.equal(local.role, 'member');
    assert.equal(local.shareable[0].projectName, 'Synthetic Friendly Project');
    assert.equal(remote.agents[0].projectName, 'Synthetic Friendly Project');
  } finally { await alpha.close(); await beta.close(); }
});

test('offline disable stops locally and completes unpairing after the coordinator returns', async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.close();
    const disabled = await beta.runtime.disable();
    assert.equal(disabled.role, null);
    assert.equal(disabled.remoteRemovalPending, true);
    assert.equal(beta.runtime.runnerActive(), false);
    await alpha.runtime.resume();
    await beta.runtime.resume();
    const cleared = await beta.runtime.status();
    assert.equal(cleared.role, null);
    assert.equal(cleared.remoteRemovalPending, false);
    assert.deepEqual((await alpha.app.peer.remoteAgents()).agents, []);
  } finally { await alpha.close(); await beta.close(); }
});

test('console refresh receives remote replies without requiring another Agent tool call', async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    const ask = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: await remoteAddress(alpha.app), body: 'Synthetic console refresh', wait: false });
    await alpha.app.peer.waitFor(ask.messageId, 5_000);
    await alpha.app.roundtable.refreshRemote({ threadId: ask.threadId });
    const view = alpha.app.roundtable.thread({ threadId: ask.threadId });
    assert.equal(view.messages[0].status, 'answered');
    assert.equal(view.messages.at(-1).body, 'beta answers');
    assert.equal(alpha.app.roundtable.threads().threads[0].waiting, false);
    await alpha.app.roundtable.refreshRemote({ threadId: ask.threadId });
    assert.equal(alpha.app.roundtable.thread({ threadId: ask.threadId }).messages.length, 2);
  } finally { await alpha.close(); await beta.close(); }
});
