import assert from 'node:assert/strict';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { beginTaskContext } from '../src/graphiti/agent-knowledge-workflows.js';

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
  }, begin: async input => ({ ...input, token: 'fuli-task-synthetic-fallback' }) };
  app.upsertPersonalProject = async input => {
    if (input.createOnly && projects.has(input.projectId)) {
      throw Object.assign(new Error('Conflict'), { status: 409 });
    }
    writes.push(input);
    projects.set(input.projectId, { project_id: input.projectId,
      scope_type: 'registered', profile: input.profile });
    return projects.get(input.projectId);
  };
  Object.assign(app.personal, {
    getProjectAgent: async () => { throw Object.assign(new Error('Not found'), { status: 404 }); },
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

test('an unclaimed conversation creates no project and hires nobody', async () => {
  const { run, writes, hires, resolutions } = fixture();
  for (const extra of [{}, { taskPrompt: 'A different task in this conversation.' },
    { sessionId: 'synthetic-session-b' }, { sourceApplication: 'claude_code' }]) {
    const result = await run(extra);
    assert.equal(result.context.personal_project_id, null);
    assert.equal(result.agent_receipt.owner, null);
    assert.match(result.agent_receipt.markdown, /待归属会话/);
  }
  assert.deepEqual([writes.length, hires.length, resolutions.length], [0, 0, 0]);
});

test('the fixed assistant receives an unclaimed conversation in its global scope', async () => {
  const { app, run, writes, hires } = fixture();
  app.personal.getProjectAgent = async (_, project, id) => {
    assert.equal(project, null); assert.equal(id, 'employee.assistant');
    return { ...role(null), agent_id: id, memory_scope: 'task_only' };
  };
  const result = await run();
  assert.equal(result.context.personal_project_id, null);
  assert.equal(result.agent_receipt.owner.agent_id, 'employee.assistant');
  assert.deepEqual([writes.length, hires.length], [0, 0]);
  assert.deepEqual(result.triage_candidates, { projects: [], topics: [],
    label_with: 'checkpoint_task_knowledge.triage' });
});

test('a registered project named at the start of the prompt is matched', async () => {
  const { app, run, writes, projects } = fixture({ existing: ['dingdong', 'conversation-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] });
  projects.get('dingdong').profile.name = 'DingDong';
  for (const taskPrompt of ['dingdong 那边的入口有个 bug', 'DingDong: fix the tray', '  dingdong，看下日志']) {
    const named = await run({ taskPrompt });
    assert.equal(named.context.personal_project_id, 'dingdong');
    assert.equal(named.triage_candidates, undefined);
  }
  for (const taskPrompt of ['dingdongs are loud', 'please check dingdong', '会话项目 / Conversation project 继续']) {
    assert.equal((await run({ taskPrompt })).context.personal_project_id, null);
  }
  assert.equal(writes.length, 0);
});

test('a new-project prefix creates exactly one registered project', async () => {
  const { run, writes } = fixture();
  const first = await run({ taskPrompt: '新项目：Garden Planner\n帮我规划第一版' });
  const again = await run({ taskPrompt: 'new project: garden planner' });
  assert.equal(first.context.personal_project_id, 'garden-planner');
  assert.equal(again.context.personal_project_id, 'garden-planner');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].createOnly, true);
  assert.equal(writes[0].profile.name, 'Garden Planner');
  assert.equal(writes[0].profile.purpose, '新项目：Garden Planner');
  const cjk = await run({ taskPrompt: '新项目：花园规划' });
  assert.match(cjk.context.personal_project_id, /^project-[a-f0-9]{12}$/);
});

test('a name shared by several projects is ambiguous in either listing order', async () => {
  const { app, run, writes, projects } = fixture({ existing: ['alpha-one', 'alpha-two'] });
  for (const id of projects.keys()) projects.get(id).profile.name = 'Alpha';
  const listed = [...projects.values()];
  for (const order of [listed, [...listed].reverse()]) {
    app.personal.listPersonalProjects = async () => order;
    for (const taskPrompt of ['Alpha 修一下入口', '新项目：Alpha']) {
      const result = await run({ taskPrompt });
      assert.equal(result.context.personal_project_id, null);
      assert.match(result.agent_receipt.markdown, /项目归属待确认/);
    }
  }
  assert.equal(writes.length, 0);
});

test('an archived project is never selected by name', async () => {
  const { run, writes, projects } = fixture({ existing: ['old-tool'] });
  projects.get('old-tool').profile = { name: 'Old Tool', lifecycle: 'archived' };
  assert.equal((await run({ taskPrompt: 'Old Tool 再看一下' })).context.personal_project_id, null);
  const created = await run({ taskPrompt: '新项目：Old Tool' });
  assert.match(created.context.personal_project_id, /^old-tool-[a-f0-9]{12}$/);
  assert.equal(writes.length, 1);
});

test('different names with the same slug get distinct project IDs', async () => {
  const { run, writes } = fixture();
  const plus = await run({ taskPrompt: '新项目：Alpha+Beta' });
  const space = await run({ taskPrompt: '新项目：Alpha Beta' });
  assert.equal(plus.context.personal_project_id, 'alpha-beta');
  assert.match(space.context.personal_project_id, /^alpha-beta-[a-f0-9]{12}$/);
  assert.equal(writes.length, 2);
});

test('a concurrent create of the same name resolves to that project', async () => {
  const { app, run, writes, projects } = fixture();
  projects.set('garden-planner', { project_id: 'garden-planner', scope_type: 'registered',
    profile: { name: 'Garden Planner', lifecycle: 'active' } });
  app.personal.listPersonalProjects = async () => [];
  const result = await run({ taskPrompt: '新项目：Garden Planner' });
  assert.equal(result.context.personal_project_id, 'garden-planner');
  assert.equal(writes.length, 0);
});

test('a registered lifecycle binding restores its project before AR recruitment', async () => {
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
  assert.equal((await run()).context.personal_project_id, null);
});

test('another session, another client and ended assignments cannot bind this chat', async () => {
  const { run } = fixture({ existing: ['unrelated'], assignments: [
    { personal_project_id: 'unrelated', source_application: 'codex', source_session_id: 'elsewhere', status: 'active' },
    { personal_project_id: 'unrelated', source_application: 'claude_code', source_session_id: 'synthetic-host-a', status: 'active' },
    { personal_project_id: 'unrelated', source_application: 'codex', source_session_id: 'synthetic-host-a', status: 'ended' }
  ] });
  assert.equal((await run({ sessionId: null })).context.personal_project_id, null);
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
  assert.equal((await run()).context.personal_project_id, null);
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

test('a failed AR recruitment reports failure and never fabricates an owner', async () => {
  const { run, app } = fixture({ resolution: { status: 'matched', personalProjectId: 'leadless' } });
  app.personal.getPersonalProject = async () => ({ project_id: 'leadless', scope_type: 'registered', profile: { name: 'leadless' } });
  app.personal.staffDefaultProjectLead = async () => { throw new Error('Staffing unavailable'); };
  const result = await run();
  assert.equal(result.agent_receipt.owner, null);
  assert.match(result.agent_receipt.markdown, /分配失败/);
});

test('an explicit global FLA keeps its identity and memory without provisioning a project', async () => {
  const { app, run, writes, hires, resolutions } = fixture();
  const agent = { ...role(null), agent_id: 'global-engineer', memory_scope: 'reviewed_agent' };
  app.personal.listProjectAgents = async (_, project) => {
    assert.equal(project, null);
    return [agent];
  };
  app.personal.getProjectAgent = async (_, project, id) => {
    assert.equal(project, null); assert.equal(id, agent.agent_id); return agent;
  };
  const memoryReads = [];
  app.personal.getProjectAgentMemory = async input => {
    assert.equal(input.personalProjectId, null);
    memoryReads.push(input);
    return { revision: 0, scope: 'private_agent_global', personal_project_id: null,
      personal_space_id: 'synthetic-space', agent_id: agent.agent_id };
  };
  for (const input of [{ projectAgentId: agent.agent_id }, { taskPrompt: '@{global-engineer} Continue.' }]) {
    const result = await run(input);
    assert.equal(result.context.personal_project_id, null);
    assert.equal(result.context.project_agent_id, agent.agent_id);
    assert.equal(result.project_agent_context.status, 'ready');
    assert.equal(result.project_agent_context.memory.scope, 'private_agent_global');
    // Global entry memory is already the global layer; it is not fetched twice.
    assert.equal(Object.hasOwn(result.project_agent_context, 'global_memory'), false);
    assert.equal(result.project_agent_context.project_brief, null);
    assert.deepEqual(result.project_agent_context.recent_tasks, []);
    assert.equal(result.agent_receipt.owner.agent_id, agent.agent_id);
  }
  assert.deepEqual([writes.length, hires.length, resolutions.length], [0, 0, 0]);
  // Two entry calls, one global-layer read each.
  assert.equal(memoryReads.length, 2);
});

test('a global host session resumes the same FLA without creating a project', async () => {
  const { app, run, writes } = fixture({ current: { personalProjectId: null, projectAgentId: 'global-engineer' } });
  app.personal.getProjectAgent = async (_, project, id) => {
    assert.equal(project, null); assert.equal(id, 'global-engineer');
    return { ...role(null), agent_id: id, memory_scope: 'task_only' };
  };
  const result = await run();
  assert.equal(result.agent_receipt.owner.agent_id, 'global-engineer');
  assert.equal(result.context.personal_project_id, null);
  assert.equal(writes.length, 0);
});

test('unavailable global identities never load memory or provision a replacement', async () => {
  for (const profile of [{ status: 'archived', allowed_clients: ['codex'] },
    { status: 'active', allowed_clients: ['claude_code'] }]) {
    const { app, run, writes, hires } = fixture();
    app.personal.getProjectAgent = async () => ({ ...role(null), profile });
    app.personal.getProjectAgentMemory = async () => assert.fail('No memory access for rejected identity');
    const result = await run({ projectAgentId: 'global-engineer' });
    assert.equal(result.agent_receipt.owner, null);
    assert.equal(result.project_agent_context.status, 'agent_unavailable');
    assert.deepEqual([writes.length, hires.length], [0, 0]);
  }
});

test('same-turn and checkpoint entry use the saved preference scope before reading preferences', async () => {
  const saved = { token: 'fuli-task-fixed-preference', sessionId: 'scope-session', turnId: 'turn-one',
    personalProjectId: 'scope-project', projectAgentId: null,
    preferenceScope: { version: 1, work_kind: 'review', workflow: 'release' } };
  const reads = [], writes = [];
  const app = { taskContextRegistry: { current: async () => saved, context: async () => saved,
    begin: async input => { writes.push(input); return input.turnId === saved.turnId ? saved : { ...input, token: 'fuli-task-new-scope' }; } },
    getCollaborationPreferences: async input => { reads.push(input); return { context: {
      personal_project_id: input.personalProjectId, project_agent_id: null } }; } };
  const input = { sessionId: saved.sessionId, sourceApplication: 'codex', turnId: saved.turnId };
  for (const extra of [{}, { turnId: 'continuation', taskPrompt: `FULI_CHECKPOINT_REQUIRED: ${saved.token} continue` }]) {
    const result = await beginTaskContext(app, { ...input, ...extra });
    assert.equal(result.taskContextToken, saved.token);
    assert.equal(reads.at(-1).workKind, 'review');
    assert.equal(reads.at(-1).workflow, 'release');
  }
  for (const change of [{ workKind: 'implementation' }, { workflow: null }]) {
    await assert.rejects(beginTaskContext(app, { ...input, ...change }), error => error.status === 409);
  }
  assert.equal(reads.length, 2, 'conflicts must fail before preference reads');
  await beginTaskContext(app, { ...input, turnId: 'new-user-turn', workKind: 'implementation' });
  assert.equal(writes.length, 2, 'registered retry keeps the Provider begin authorization check');
  assert.deepEqual(writes[1].preferenceScope, { version: 1, work_kind: 'implementation', workflow: null });
  saved.preferenceScope = null;
  await assert.rejects(beginTaskContext(app, input), /preference scope.*unknown/i);
  assert.equal(reads.length, 3, 'a legacy scope cannot be guessed on recovery');
});

test('fresh ordinary fallback forwards preference dimensions without inheriting the previous task scope', async () => {
  const { app, run } = fixture({ existing: ['chosen'], resolution: { status: 'matched', personalProjectId: 'chosen' },
    current: { personalProjectId: 'chosen', preferenceScope: { version: 1, work_kind: 'old', workflow: 'old' } } });
  const writes = [];
  app.taskContextRegistry.begin = async input => {
    writes.push(input); return { ...input, token: `fuli-task-fresh-scope-${writes.length}` };
  };
  const first = await run({ taskPrompt: 'First task', workKind: 'review', workflow: 'release' });
  const second = await run({ taskPrompt: 'Another task' });
  assert.notEqual(first.taskContextToken, second.taskContextToken);
  assert.deepEqual(writes.map(input => input.preferenceScope), [
    { version: 1, work_kind: 'review', workflow: 'release' },
    { version: 1, work_kind: null, workflow: null }]);
});
