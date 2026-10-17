import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';

function fixture({ missingLead = false, available = true, sessions = true, memoryResults = 0 } = {}) {
  const agent = id => ({ agentId: id, profile: { name: id, status: 'active',
    allowedClients: ['codex'], responsibility: 'Synthetic project lead', capabilities: [] } });
  const roster = [agent('source-lead'), ...(missingLead ? [] : [agent('target-lead')])];
  const policies = { source: { team_lead_agent_id: 'source-lead' },
    target: { team_lead_agent_id: missingLead ? null : 'target-lead' } };
  const contexts = { source: { personalProjectId: 'source', projectAgentId: 'source-lead',
    sourceApplication: 'codex', sessionId: 'source-session' },
    target: { personalProjectId: 'target', projectAgentId: 'target-lead', sourceApplication: 'codex', sessionId: 'target-session' },
    other: { personalProjectId: 'other', projectAgentId: 'target-lead', sourceApplication: 'codex', sessionId: 'other-session' } };
  const grants = [], wakes = [], observations = [], hires = [];
  const app = { config: { personal: { spaceId: 'space' } }, listProjectAgents: async () => roster,
    projectPathResolver: path => ({ status: 'matched', personalProjectId: path.split('/').at(-1) }),
    taskContextRegistry: { context: async token => contexts[token] }, personal: {
      getPersonalProject: async (_, id) => ({ project_id: id, profile: { name: id, lifecycle: 'active' } }),
      listPersonalProjects: async () => ['source', 'target'].map(project_id => ({ project_id })),
      getProjectAgentCoordinationPolicy: async (_, id) => policies[id] ?? {},
      staffDefaultProjectLead: async input => {
        hires.push(input); roster.push(agent('target-lead')); policies.target.team_lead_agent_id = 'target-lead';
        return { status: 'ready', agent: { agent_id: 'target-lead' } };
      },
      recentAgentSessions: async ({ agentId }) => sessions && agentId === 'target-lead'
        ? [{ source_application: 'codex', session_id: 'target-session', personal_project_id: 'target' }] : [],
      issueAgentDelegation: async input => { grants.push(input); return { token: 'synthetic-target-grant' }; },
      verifyAgentDelegation: async () => ({ redeemed: true, memory_result_count: memoryResults }), revokeAgentDelegation: async () => ({}),
      recordProjectMemoryUsage: async input => { observations.push(input); return { recorded: true }; }
    } };
  let id = 0;
  const store = createRoundtableStore();
  const roundtable = createAgentRoundtable({ app, openStore: () => store, idFactory: () => 'cross-' + ++id,
    clientAvailable: () => available, locateCwd: (_, session) => '/work/' + session,
    wake: async input => { wakes.push(input); return { body: 'Bounded target result', sessionId: 'target-session' }; } });
  return { app, contexts, roundtable, store, grants, wakes, observations, hires };
}

test('project discovery returns its lead and explicit project address without staffing', async () => {
  const f = fixture();
  const result = await f.roundtable.findAgents({ personalProjectId: 'target' });
  assert.deepEqual(result.agents.map(a => a.agentId), ['target-lead']);
  assert.equal(result.project.address, 'project:target');
  assert.equal(f.hires.length, 0);
});

test('cross-project delivery restores target directory and returns to the unchanged source lead', async () => {
  const f = fixture({ memoryResults: 2 });
  const original = structuredClone(f.contexts.source);
  const result = await f.roundtable.messageAgent({ taskContextToken: 'source',
    to: 'project:target', body: 'Return one bounded target fact', projectPath: '/work/source' });
  assert.equal(result.status, 'answered');
  assert.equal(result.reply, 'Bounded target result');
  assert.equal(f.wakes[0].cwd, '/work/target-session');
  assert.match(f.wakes[0].prompt, /personalProjectId.*target/);
  assert.equal(f.grants[0].target_personal_project_id, 'target');
  assert.equal(f.grants[0].task_context_token, 'source');
  assert.deepEqual(f.contexts.source, original);
  assert.equal(f.hires.length, 0);
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].target_project_id, 'target');
  assert.equal(f.observations[0].channel, 'roundtable_answer');
  assert.equal(f.observations[0].result_count, 2);
  assert.equal(f.observations[0].body, undefined);
  assert.equal(f.roundtable.thread({ threadId: result.threadId }).messages[1].to.agentId, 'source-lead');
});

test('a missing lead uses existing HR once and a verified target folder; unavailable client never hires', async () => {
  const f = fixture({ missingLead: true, sessions: false });
  const result = await f.roundtable.messageAgent({ taskContextToken: 'source', to: 'project:target',
    body: 'Synthetic new lead question', projectPath: '/work/target', conversation: 'new' });
  assert.equal(result.status, 'answered');
  assert.equal(f.hires.length, 1);
  assert.equal(f.wakes[0].cwd, '/work/target');
  const unavailable = fixture({ available: false });
  const pending = await unavailable.roundtable.messageAgent({ taskContextToken: 'source',
    to: 'project:target', body: 'Synthetic unavailable client question' });
  assert.equal(pending.status, 'queued');
  assert.equal(pending.reason, 'no_client');
  assert.equal(unavailable.hires.length, 0);
  assert.equal(unavailable.observations.length, 0);
});

test('queued cross-project inbox and replies are limited to the receiving project', async () => {
  const f = fixture();
  const pending = await f.roundtable.messageAgent({ taskContextToken: 'source', to: 'project:target',
    body: 'Synthetic deferred question', wait: false });
  assert.equal((await f.roundtable.readMessages({ taskContextToken: 'other' })).messages.length, 0);
  await assert.rejects(f.roundtable.replyMessage({ taskContextToken: 'other', messageId: pending.messageId,
    body: 'Unauthorized project reply' }));
  assert.equal((await f.roundtable.readMessages({ taskContextToken: 'target' })).messages.length, 1);
  await f.roundtable.replyMessage({ taskContextToken: 'target', messageId: pending.messageId, body: 'Synthetic reply' });
  const result = await f.roundtable.messageStatus({ taskContextToken: 'source', messageId: pending.messageId });
  assert.equal(result.reply, 'Synthetic reply');
  assert.equal(f.observations.length, 0, 'a manual reply alone proves communication, not a memory read');
});

test('an answered consultation without a verified memory hit never adds project weight', async () => {
  const f = fixture();
  const result = await f.roundtable.messageAgent({ taskContextToken: 'source',
    to: 'project:target', body: 'A synthetic greeting without memory retrieval' });
  assert.equal(result.status, 'answered');
  assert.equal(f.observations.length, 0);
  await f.roundtable.messageStatus({ taskContextToken: 'source', messageId: result.messageId });
  assert.equal(f.observations.length, 0);
});
