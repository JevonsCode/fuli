import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';

// A synthetic host and an injected wake: no client is started.
function roundtable({ ownerGrant = true, wake } = {}) {
  const calls = { grants: [], revoked: [], wakes: [] };
  const lead = { agentId: 'synthetic-lead', profile: { name: 'Synthetic lead', status: 'active', allowedClients: ['claude_code', 'codex'] },
    assignments: [{ personalProjectId: 'synthetic-project', status: 'active' }] };
  const host = {
    spaceId: () => 'synthetic-space', listAgents: async () => [lead], recentSessions: async () => [],
    taskContext: async () => ({}), listProjects: async () => [], getProject: async () => ({}), projectLeadId: async () => lead.agentId,
    staffProjectLead: async () => ({ status: 'ready' }), projectTeam: async () => ({ lead: null, people: [] }), projectForPath: async () => null,
    issueDelegation: async () => ({ token: 'task-grant' }), issueRemoteDelegation: async () => ({ token: 'remote-grant' }),
    sealDelegation: async () => ({}), verifyDelegation: async () => ({ redeemed: true }),
    revokeDelegation: async ({ token }) => { calls.revoked.push(token); },
    issueRemoteOrigin: async () => ({}), remoteOriginAuthority: async () => ({}),
    ...(ownerGrant ? { issueOwnerDelegation: async (input) => { calls.grants.push(input); return { token: `owner-grant-${calls.grants.length}` }; } } : {})
  };
  const service = createAgentRoundtable({ host, openStore: () => createRoundtableStore(), clientAvailable: () => true,
    wake: async (input) => { calls.wakes.push(input); return wake ? wake(input) : { body: 'Edited the worktree.', sessionId: 'synthetic-session' }; } });
  return { service, calls };
}

const VISIT = { agentId: 'synthetic-lead', projectId: 'synthetic-project', subject: 'Port from settings',
  cwd: '/synthetic/visit-worktrees/request-1', prompt: '#FLA {synthetic-lead} visit', timeoutMs: 900_000 };

test('a visit request wakes a fresh session of the lead in its worktree, under the owner\'s grant, in the asked mode', async (t) => {
  const { service, calls } = roundtable();
  t.after(() => service.close());
  const answer = await service.wakeForVisit({ ...VISIT, mode: 'worktree_edit' });
  assert.deepEqual(answer, { body: 'Edited the worktree.', client: 'claude_code' });
  assert.deepEqual(calls.wakes.map((wake) => [wake.client, wake.sessionId, wake.cwd, wake.mode, wake.delegationToken]),
    [['claude_code', null, VISIT.cwd, 'worktree_edit', 'owner-grant-1']]);
  assert.deepEqual([calls.grants[0].projectId, calls.grants[0].agentId, calls.grants[0].targetSessionId], ['synthetic-project', 'synthetic-lead', null]);
  assert.deepEqual(calls.revoked, ['owner-grant-1'], 'the grant ends with the wake');
  // A planning wake is the same path, read-only.
  await service.wakeForVisit({ ...VISIT, mode: 'read_only' });
  assert.equal(calls.wakes.at(-1).mode, 'read_only');
});

test('without an owner grant nothing is woken; a failed wake is thrown with its code', async (t) => {
  const bare = roundtable({ ownerGrant: false });
  t.after(() => bare.service.close());
  await assert.rejects(bare.service.wakeForVisit({ ...VISIT, mode: 'worktree_edit' }), { code: 'owner_grant_unavailable' });
  assert.deepEqual(bare.calls.wakes, []);

  const failing = roundtable({ wake: async () => { throw Object.assign(new Error('timed out'), { code: 'wake_timeout' }); } });
  t.after(() => failing.service.close());
  await assert.rejects(failing.service.wakeForVisit({ ...VISIT, mode: 'worktree_edit' }), { code: 'wake_timeout' });
  assert.equal(failing.calls.wakes.length, 1, 'a timeout ends the wake; no second client is tried');
});
