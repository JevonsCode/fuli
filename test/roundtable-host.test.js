import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRoundtableHost, ROUNDTABLE_HOST_METHODS } from '../src/agent-roundtable/host.js';
import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

test('Roundtable refuses a host that is missing part of the port', () => {
  const partial = Object.fromEntries(ROUNDTABLE_HOST_METHODS.slice(1).map(name => [name, () => null]));
  assert.throws(() => assertRoundtableHost(partial), /missing: spaceId/);
  assert.throws(() => createAgentRoundtable({ host: partial, openStore: () => createRoundtableStore() }), /missing: spaceId/);
});

test('FULI hosts Roundtable with its Provider records in the port shapes', async () => {
  const calls = [];
  const app = {
    config: { personal: { spaceId: 'space-1' } },
    listProjectAgents: async input => { calls.push(['agents', input]); return [{ agentId: 'lead', profile: { status: 'active' } }]; },
    taskContextRegistry: { context: async (token, client) => ({ token, client }) },
    projectPathResolver: path => path === '/work/app' ? { status: 'matched', personalProjectId: 'app' } : { status: 'unmatched' },
    personal: {
      recentAgentSessions: async input => { calls.push(['sessions', input]);
        return [{ source_application: 'codex', session_id: 's-1', personal_project_id: 'app', last_active: 't' }]; },
      listPersonalProjects: async () => ({ projects: [{ project_id: 'app', profile: { name: 'App' }, scope_type: 'registered' },
        { project_id: 'tmp', scope_type: 'temporary', profile: { lifecycle: 'archived' } }] }),
      getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'lead' }),
      issueAgentDelegation: async input => { calls.push(['issue', input]); return { token: 't' }; },
      verifyAgentDelegation: async () => ({ redeemed: true, memory_result_count: 2 }),
      issueRemoteAgentOrigin: async input => { calls.push(['origin', input]); return { agent_id: 'lead', proof: 'p' }; }
    }
  };
  const host = createFuliRoundtableHost(app);
  assert.equal(host.spaceId(), 'space-1');
  assert.deepEqual(await host.recentSessions({ agentId: 'lead', projectId: 'app', limit: 5 }),
    [{ client: 'codex', sessionId: 's-1', projectId: 'app', lastActive: 't' }]);
  assert.deepEqual(calls.at(-1), ['sessions', { personalSpaceId: 'space-1', agentId: 'lead', personalProjectId: 'app', limit: 5 }]);
  assert.deepEqual(await host.listProjects(), [{ projectId: 'app', name: 'App', temporary: false, archived: false },
    { projectId: 'tmp', name: null, temporary: true, archived: true }]);
  assert.equal(await host.projectLeadId('app'), 'lead');
  assert.equal(await host.projectForPath('/work/app'), 'app');
  assert.equal(await host.projectForPath('/elsewhere'), null);
  assert.deepEqual(await host.verifyDelegation({ token: 't', sessionId: 's' }), { redeemed: true, memoryResultCount: 2 });
  await host.issueDelegation({ taskContextToken: 'task', client: 'codex', agentId: 'lead', targetClient: 'claude_code',
    targetSessionId: null, lifetimeSeconds: 60 });
  assert.deepEqual(calls.at(-1), ['issue', { personal_space_id: 'space-1', task_context_token: 'task', source_application: 'codex',
    agent_id: 'lead', target_application: 'claude_code', target_session_id: null, lifetime_seconds: 60 }]);
  await host.issueRemoteOrigin({ taskContextToken: 'task', client: 'codex', messageId: 'm', digest: 'd', targetNode: 'n',
    bindingId: 'chat', expiresAt: 'e', purpose: 'chat' });
  assert.equal(calls.at(-1)[1].purpose, 'chat');
  assert.deepEqual(await host.recordMemoryUsage({}), { recorded: false, reason: 'usage_port_unavailable' });
});
