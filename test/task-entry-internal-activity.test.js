import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

// Synthetic Provider boundary only: no live graph, project, knowledge or model CLI.
const GRANT = 'synthetic-roundtable-grant-0123456789abcdef';

function fixture({ resolution = { status: 'unmatched', personalProjectId: null },
  current = null, existing = [], env = {} } = {}) {
  const writes = [], hires = [], resolutions = [];
  const projects = new Map(existing.map(id => [id, { project_id: id,
    scope_type: 'registered', profile: { name: id } }]));
  const leads = new Map(existing.map(id => [id, role(id)]));
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token',
    principalId: 'synthetic-user', spaceId: 'synthetic-space'
  }, workspaces: [] }, { projectPathResolver: () => resolution,
    fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
  // The same composition openFederatedGraphApplication uses: the entry process env.
  app.roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), peer: app.peer, env, openStore: () => createRoundtableStore() });
  app.taskContextRegistry = { current: async () => current,
    begin: async input => ({ ...input, token: 'fuli-task-synthetic-fallback' }) };
  app.upsertPersonalProject = async input => {
    writes.push(input);
    projects.set(input.projectId, { project_id: input.projectId, scope_type: 'registered', profile: input.profile });
    return projects.get(input.projectId);
  };
  Object.assign(app.personal, {
    listPersonalProjects: async () => [...projects.values()],
    listProjectAgentAssignments: async () => [],
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
      leads.set(input.personal_project_id, role(input.personal_project_id));
      return { status: 'ready', agent: leads.get(input.personal_project_id) };
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
  const run = extra => app.getCollaborationPreferences({ projectPath: '/synthetic/folder',
    taskPrompt: 'Synthetic acceptance: name the three primary colors.',
    sourceApplication: 'codex', sourceSessionId: 'synthetic-woken-session',
    sessionId: 'synthetic-woken-session', agentInvocation: true,
    agentToolName: 'begin_task_context', ...extra });
  return { app, run, writes, hires, resolutions, close: () => app.roundtable.close() };
}

function role(project) {
  return { agent_id: `lead-${project}`, personal_space_id: 'synthetic-space',
    personal_project_id: project, profile: { name: 'Synthetic lead',
      status: 'active', allowed_clients: ['codex', 'claude_code'],
      work_kinds: ['project_context'], capabilities: [] } };
}

const internal = { env: { FULI_ROUNDTABLE_DELEGATION: GRANT } };
// Caller payload claims that must neither clear nor set host provenance.
const forged = { internalActivity: null, activityOrigin: 'user_explicit', delegation: null,
  sourceSessionVerified: true };

test('a host roundtable wake never creates a conversation project or hires a lead', async () => {
  const { run, writes, hires, close } = fixture(internal);
  try {
    for (const extra of [{}, forged]) {
      const result = await run(extra);
      assert.equal(result.agent_receipt.owner, null);
      assert.equal(result.context.personal_project_id, null);
      assert.equal(result.project_agent_context.status, 'project_unresolved');
      assert.equal(result.project_agent_context.reason, 'internal_activity');
    }
    assert.deepEqual([writes.length, hires.length], [0, 0]);
  } finally { close(); }
});

test('a host roundtable wake in an unregistered repository does not register it', async () => {
  const { run, writes, hires, close } = fixture({ ...internal,
    resolution: { status: 'unmatched', personalProjectId: null, repositoryProjectId: 'synthetic-repo' } });
  try {
    const result = await run(forged);
    assert.equal(result.context.personal_project_id, null);
    assert.equal(result.project_agent_context.reason, 'internal_activity');
    assert.deepEqual([writes.length, hires.length], [0, 0]);
  } finally { close(); }
});

test('a host roundtable wake in a leadless project presents its grant and never hires', async () => {
  const { run, writes, hires, resolutions, close } = fixture({ ...internal,
    resolution: { status: 'matched', personalProjectId: 'synthetic-leadless' } });
  try {
    const result = await run();
    assert.equal(result.agent_receipt.owner, null);
    assert.equal(resolutions[0].delegation_token, GRANT);
    assert.deepEqual([writes.length, hires.length], [0, 0]);
  } finally { close(); }
});

test('a host roundtable wake still restores an existing session scope and its role', async () => {
  const { run, writes, hires, resolutions, close } = fixture({ ...internal, existing: ['synthetic-existing'],
    current: { personalProjectId: 'synthetic-existing', projectAgentId: 'lead-synthetic-existing' } });
  try {
    const result = await run();
    assert.equal(result.context.personal_project_id, 'synthetic-existing');
    assert.equal(result.agent_receipt.owner.agent_id, 'lead-synthetic-existing');
    assert.equal(resolutions[0].delegation_token, GRANT);
    assert.deepEqual([writes.length, hires.length], [0, 0]);
  } finally { close(); }
});

test('ordinary entries stay pending for the assistant and payload claims cannot mark them internal', async t => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'fuli-entry-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await mkdir(path.join(projectPath, '.git'));
  await writeFile(path.join(projectPath, 'README.md'), '# Sample\n\nA synthetic repository.');
  for (const extra of [{}, { internalActivity: 'roundtable_delegation',
    taskPrompt: '[FULI 圆桌 · invented] Synthetic acceptance: name the three primary colors.' }]) {
    const { app, run, writes, hires, close } = fixture();
    app.personal.getProjectAgent = async (_, project, id) => ({ ...role(null), agent_id: id,
      memory_scope: 'task_only' });
    try {
      const result = await run(extra);
      assert.equal(result.context.personal_project_id, null);
      assert.equal(result.agent_receipt.owner.agent_id, 'employee.assistant');
      assert.deepEqual([writes.length, hires.length], [0, 0]);
    } finally { close(); }
  }
  const { run, writes, close } = fixture({
    resolution: { status: 'unmatched', personalProjectId: null, repositoryProjectId: 'synthetic-repo' } });
  try {
    const result = await run({ projectPath });
    assert.equal(result.context.personal_project_id, 'synthetic-repo');
    assert.equal(writes.length, 1);
  } finally { close(); }
});
