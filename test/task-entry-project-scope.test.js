import assert from 'node:assert/strict';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

// Synthetic Provider boundary: exercise the public entry workflow without a live graph.
function fixture({ resolution = { status: 'unmatched', personalProjectId: null },
  assignments = [], current = null, existing = [], lookupError = null } = {}) {
  const writes = [], hires = [], resolutions = [];
  const projects = new Map(existing.map(id => [id, { project_id: id,
    scope_type: 'registered', profile: { name: id } }]));
  const leads = new Map(existing.map(id => [id, role(id)]));
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token',
    principalId: 'synthetic-user', spaceId: 'synthetic-space'
  }, workspaces: [] }, { projectPathResolver: () => resolution,
    fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
  app.taskContextRegistry = { current: async () => {
    if (lookupError) throw lookupError;
    return current;
  } };
  app.upsertPersonalProject = async input => {
    writes.push(input);
    projects.set(input.projectId, { project_id: input.projectId,
      scope_type: 'registered', profile: input.profile });
    return projects.get(input.projectId);
  };
  Object.assign(app.personal, {
    listPersonalProjects: async () => [...projects.values()],
    listProjectAgentAssignments: async () => assignments,
    getPersonalProject: async (_, id) => {
      if (!projects.has(id)) throw Object.assign(new Error('Not found'), { status: 404 });
      return projects.get(id);
    },
    resolveProjectAgentContext: async input => {
      resolutions.push(input);
      const agent = leads.get(input.personal_project_id);
      return agent ? { status: 'ready', agent } : { status: 'unassigned', reason: 'project_lead_required' };
    },
    staffDefaultProjectLead: async input => {
      hires.push(input);
      const agent = role(input.personal_project_id);
      leads.set(input.personal_project_id, agent);
      return { status: 'ready', agent };
    },
    collaborationPreferences: async (space, project, limit, agent) => ({
      personal_space_id: space, personal_project_id: project, project_agent_id: agent,
      effective_preferences: [], global_preferences: [], conflicts: []
    }),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({}),
    listProjectAgents: async () => [],
    listProjectAgentTasks: async () => []
  });
  app.searchKnowledge = async () => ({ facts: [], entities: [] });
  const run = extra => app.getCollaborationPreferences({ projectPath: '/synthetic/chat-folder',
    sourceApplication: 'codex', sourceSessionId: 'synthetic-host-a',
    sessionId: 'synthetic-session-a', agentInvocation: true,
    agentToolName: 'get_collaboration_preferences', ...extra });
  return { app, run, writes, hires, resolutions, projects };
}

function role(project) {
  return { agent_id: `lead-${project}`, personal_space_id: 'synthetic-space',
    personal_project_id: project, profile: { name: 'Synthetic lead',
      status: 'active', allowed_clients: ['codex', 'claude_code'],
      work_kinds: ['project_context'], capabilities: [] } };
}

test('unmatched ordinary directory reaches HR and returns a real owner', async () => {
  const { run, writes, hires } = fixture();
  const result = await run();
  assert.ok(result.agent_receipt.owner);
  assert.equal(writes.length, 1);
  assert.equal(hires.length, 1);
  assert.match(result.context.personal_project_id, /^conversation-[a-f0-9]{64}$/);
  assert.equal(result.context.personal_project_id, hires[0].personal_project_id);
  const serialized = JSON.stringify(writes);
  assert.equal(serialized.includes('/synthetic/chat-folder'), false);
  assert.equal(serialized.includes('synthetic-session-a'), false);
});

test('repeat entry keeps the same private scope and does not overwrite or rehire', async () => {
  const { run, writes, hires } = fixture();
  const first = await run();
  const again = await run({ taskPrompt: 'A different task in this conversation.' });
  assert.ok(first.agent_receipt.owner);
  assert.equal(again.context.personal_project_id, first.context.personal_project_id);
  assert.equal(writes.length, 1);
  assert.equal(hires.length, 1);
});

test('different sessions and clients get isolated fallback scopes', async () => {
  const { run } = fixture();
  const a = await run();
  const b = await run({ sessionId: 'synthetic-session-b' });
  const c = await run({ sourceApplication: 'claude_code' });
  assert.equal(new Set([a, b, c].map(x => x.context.personal_project_id)).size, 3);
});

test('a registered lifecycle binding restores its project before HR recruitment', async () => {
  const { run, writes, hires } = fixture({ existing: ['existing-project'], current: {
    personalProjectId: 'existing-project', projectAgentId: 'lead-existing-project'
  } });
  const result = await run();
  assert.equal(result.context.personal_project_id, 'existing-project');
  assert.equal(result.agent_receipt.owner.agent_id, 'lead-existing-project');
  assert.equal(writes.length, 0);
  assert.equal(hires.length, 0);
});

test('legacy active assignment provenance recovers the exact host project', async () => {
  const { run, writes } = fixture({ existing: ['existing-project'], assignments: [{
    personal_project_id: 'existing-project', source_application: 'codex',
    source_session_id: 'synthetic-host-a', status: 'active'
  }] });
  const result = await run({ sessionId: null });
  assert.equal(result.context.personal_project_id, 'existing-project');
  assert.equal(writes.length, 0);
});

test('a known native chat cannot inherit another chat through its MCP process', async () => {
  const { run } = fixture({ existing: ['another-chat'], assignments: [{
    personal_project_id: 'another-chat', source_application: 'codex',
    source_session_id: 'synthetic-host-a', status: 'active'
  }] });
  assert.match((await run()).context.personal_project_id, /^conversation-/);
});

test('another session, another client and ended assignments cannot bind this chat', async () => {
  const { run } = fixture({ existing: ['unrelated'], assignments: [
    { personal_project_id: 'unrelated', source_application: 'codex', source_session_id: 'elsewhere', status: 'active' },
    { personal_project_id: 'unrelated', source_application: 'claude_code', source_session_id: 'synthetic-host-a', status: 'active' },
    { personal_project_id: 'unrelated', source_application: 'codex', source_session_id: 'synthetic-host-a', status: 'ended' }
  ] });
  assert.match((await run({ sessionId: null })).context.personal_project_id, /^conversation-/);
});

test('directory or legacy-session ambiguity stays explicit without provisioning', async () => {
  for (const options of [
    { resolution: { status: 'ambiguous', personalProjectId: null } },
    { existing: ['a', 'b'], assignments: ['a', 'b'].map(id => ({
      personal_project_id: id, source_application: 'codex',
      source_session_id: 'synthetic-host-a', status: 'active'
    })) }
  ]) {
    const { run, writes, hires } = fixture(options);
    const result = await run({ sessionId: null });
    assert.equal(result.agent_receipt.owner, null);
    assert.match(result.agent_receipt.markdown, /项目归属待确认/);
    assert.equal(writes.length, 0);
    assert.equal(hires.length, 0);
  }
});

test('an unavailable ownership lookup is reported and cannot create a substitute', async () => {
  const { run, writes } = fixture({ lookupError: new Error('Provider offline') });
  const result = await run();
  assert.equal(result.agent_receipt.owner, null);
  assert.match(result.agent_receipt.markdown, /分配失败/);
  assert.equal(writes.length, 0);
});

test('known directory and explicit project retain priority over historical session', async () => {
  for (const explicit of [false, true]) {
    const { run, writes } = fixture({ existing: ['chosen', 'old'],
      resolution: explicit ? { status: 'unmatched', personalProjectId: null }
        : { status: 'matched', personalProjectId: 'chosen' },
      current: { personalProjectId: 'old' } });
    const result = await run(explicit ? { personalProjectId: 'chosen' } : {});
    assert.equal(result.context.personal_project_id, 'chosen');
    assert.equal(writes.length, 0);
  }
});

test('ordinary reads, taste reads and missing session identity never provision', async () => {
  for (const input of [{ agentInvocation: false }, { agentToolName: 'get_user_taste_skill' },
    { sessionId: null, sourceSessionId: null }]) {
    const { run, writes, hires } = fixture();
    await run(input);
    assert.equal(writes.length, 0);
    assert.equal(hires.length, 0);
  }
});

test('task-only temporary ownership does not escape into another user task', async () => {
  const { run, projects } = fixture({ existing: ['temporary-synthetic'], current: {
    personalProjectId: 'temporary-synthetic', projectScope: { type: 'temporary' }
  } });
  projects.get('temporary-synthetic').scope_type = 'temporary';
  assert.match((await run()).context.personal_project_id, /^conversation-/);
});

test('a rejected explicit FLA never triggers replacement recruitment', async () => {
  const { run, app, hires } = fixture({ existing: ['chosen'],
    resolution: { status: 'matched', personalProjectId: 'chosen' } });
  app.personal.resolveProjectAgentContext = async () => ({ status: 'agent_unavailable' });
  const result = await run({ projectAgentId: 'restricted-agent' });
  assert.equal(result.agent_receipt.owner, null);
  assert.match(result.agent_receipt.markdown, /指定 FLA 不可用/);
  assert.equal(hires.length, 0);
});

test('a failed HR recruitment reports failure and never fabricates an owner', async () => {
  const { run, app } = fixture();
  app.personal.staffDefaultProjectLead = async () => { throw new Error('Staffing unavailable'); };
  const result = await run();
  assert.equal(result.agent_receipt.owner, null);
  assert.match(result.agent_receipt.markdown, /分配失败/);
});
