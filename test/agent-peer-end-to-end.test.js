import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function device(label, { tamper = null } = {}) {
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
    wake: async (input) => { calls.wakes.push(input); return { body: `${label} answers`, sessionId: `${label}-woken` }; } });
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

test('a project lead asks the shared lead on another paired device over TLS', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    const found = await alpha.app.roundtable.findAgents({});
    assert.equal(found.remoteAgents[0].role, 'shared_project_lead');
    assert.ok(!JSON.stringify(found).includes(beta.folder), 'local folders are never published');
    const answer = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: await remoteAddress(alpha.app), body: 'Synthetic cross-device question', timeoutSeconds: 30 });
    assert.equal(answer.status, 'answered', JSON.stringify(answer));
    assert.equal(answer.reply, 'beta answers');
    assert.equal(beta.calls.wakes.length, 1);
    assert.match(beta.calls.wakes[0].prompt, /Synthetic cross-device question/);
    assert.equal(beta.calls.wakes[0].cwd, beta.folder);
    assert.deepEqual([beta.calls.grants[0].agent_id, beta.calls.grants[0].personal_project_id], ['beta-lead', 'beta-project']);
    assert.ok(!JSON.stringify(beta.calls).includes('alpha-task'), 'the sender task token never leaves its device');
    const status = await alpha.app.roundtable.messageStatus({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      messageId: answer.messageId });
    assert.equal(status.status, 'answered');

    const [betaDevice] = (await alpha.runtime.status()).devices.filter((entry) => !entry.self);
    await alpha.runtime.revokeDevice(betaDevice.nodeId);
    const after = await alpha.app.roundtable.findAgents({});
    assert.equal(after.remoteAgents.length, 0, 'a revoked device no longer offers Agents');
  } finally { await alpha.close(); await beta.close(); }
});

test('valid TLS and device signature without the source authority proof start nothing', { timeout: 20_000 }, async () => {
  const forger = signingAuthority();
  for (const [name, tamper] of Object.entries({
    missing: () => undefined,
    tampered: (proof) => ({ ...proof, payload: Buffer.from(canonicalJson({ forged: true })).toString('base64url') }),
    forged_key: (_proof, claims) => {
      const payload = Buffer.from(canonicalJson({ ...claims, key_id: forger.keyId }));
      return { payload: payload.toString('base64url'), signature: sign(null, payload, forger.privateKey).toString('base64url') };
    },
  })) {
    const [alpha, beta] = await Promise.all([device('alpha', { tamper }), device('beta')]);
    try {
      await pair(alpha, beta);
      const result = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
        to: await remoteAddress(alpha.app), body: 'Forged question', timeoutSeconds: 30 }).catch((error) => ({ status: 'refused', code: error.code }));
      assert.ok(['failed', 'refused'].includes(result.status), `${name}: ${JSON.stringify(result)}`);
      assert.deepEqual(beta.calls.grants, [], `${name}: no receiving delegation`);
      assert.deepEqual(beta.calls.wakes, [], `${name}: nothing started`);
    } finally { await alpha.close(); await beta.close(); }
  }
});

test('a shared lead without a known project folder is not woken anywhere else', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta, { folder: false });
    const result = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: await remoteAddress(alpha.app), body: 'Question without folder', timeoutSeconds: 30 });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'no_working_directory');
    assert.deepEqual(beta.calls.wakes, []);
  } finally { await alpha.close(); await beta.close(); }
});

test('the owner chooses the shared clients and a folder of that project', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    await assert.rejects(beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: [] }] }), { code: 'invalid_clients' });
    await assert.rejects(beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['claude_code'] }] }), { code: 'invalid_clients' });
    await assert.rejects(beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['codex'],
      workingDirectory: alpha.folder }] }), { code: 'invalid_folder' });
    const [share] = (await beta.runtime.status()).shares;
    assert.deepEqual([share.clients, share.state], [['codex'], 'shared']);
  } finally { await alpha.close(); await beta.close(); }
});
