import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

// A client that got its own source after the project's lead was hired, used
// over MCP only (no lifecycle hooks, like Antigravity): the task in the
// lead's project names the lead, and a task that truly has no owner says why
// in its checkpoint receipt. Synthetic Provider boundary only; no real data.

const SPACE = 'synthetic-space';
const PROJECT = 'synthetic-project';
// The default client list every Agent hired before Antigravity had its own source stored.
const HIRED_BEFORE = ['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'opencode', 'other'];

function lead(clients) {
  return { agent_id: 'synthetic-lead', personal_space_id: SPACE, personal_project_id: null,
    memory_scope: 'reviewed_agent', updated_at: '2026-10-01T00:00:00Z',
    assignments: [{ personal_project_id: PROJECT, status: 'active' }],
    profile: { name: '负责人', display_name: 'Synthetic Lead', responsibility: 'Synthetic lead work', status: 'active',
      allowed_clients: clients, work_kinds: ['project_context'], capabilities: [], agent_type: 'durable' } };
}

function fixture(clients) {
  const tasks = [];
  const app = new FederatedGraphApplication({ version: 1, personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-test-token', principalId: 'synthetic-user', spaceId: SPACE }, workspaces: [] },
  { projectPathResolver: () => ({ status: 'matched', basis: 'repository_root', personalProjectId: PROJECT }),
    fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
  app.taskContextRegistry = {
    current: async (session, source) => tasks.findLast(task => task.sessionId === session
      && task.sourceApplication === source) ?? null,
    begin: async input => { const task = { ...input, token: `fuli-task-synthetic-${tasks.length}` };
      tasks.push(task); return task; }
  };
  app.getCapturePolicy = () => ({ enabled: true });
  Object.assign(app.personal, {
    listPersonalProjects: async () => [{ project_id: PROJECT, scope_type: 'registered', profile: { name: 'Synthetic' } }],
    getPersonalProject: async (_, id) => ({ project_id: id, scope_type: 'registered', profile: { name: 'Synthetic' } }),
    listProjectAgents: async () => [lead(clients)],
    getProjectAgent: async () => lead(clients),
    resolveProjectAgentContext: async () => ({ status: 'ready', reason: 'project_team_lead', agent: lead(clients) }),
    staffDefaultProjectLead: async () => { throw new Error('The project already has a lead'); },
    getProjectAgentMemory: async input => ({ personal_space_id: SPACE, personal_project_id: input.personalProjectId,
      agent_id: input.agentId, scope: input.personalProjectId ? 'private_agent_project' : 'private_agent_global',
      revision: 0, current: null, history: [] }),
    collaborationPreferences: async (space, project, _limit, agent) => ({ personal_space_id: space,
      personal_project_id: project, project_agent_id: agent, effective_preferences: [], global_preferences: [], conflicts: [],
      truncated: false, source_windows: { candidates_truncated: false, project_ancestors_truncated: false } }),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'synthetic-lead' }),
    listProjectAgentAssignments: async () => [],
    listProjectAgentTasks: async () => []
  });
  app.searchKnowledge = async () => ({ facts: [], entities: [] });
  return { app, tasks };
}

// Only MCP tools, as a client without lifecycle hooks reaches FULI.
async function mcpEntry(app) {
  const server = createMcpServer(app, { sourceApplication: 'antigravity', toolProfile: 'chat',
    registerResources: false, env: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic-mcp-only-client', version: '1' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'get_collaboration_preferences',
      arguments: { projectPath: '/synthetic/project', taskPrompt: 'Synthetic task in the project',
        // No native session in the environment: the model names its own conversation.
        sessionId: 'synthetic-conversation-id' } });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}

async function checkpoint(begun, clients) {
  let stored = null;
  const task = () => ({ token: begun.token, sessionId: begun.sessionId, personalProjectId: begun.personalProjectId,
    projectAgentId: begun.projectAgentId, sourceApplication: 'antigravity', agentAssignment: begun.agentAssignment,
    projectScope: null, workLogRequired: false, checkpoint: stored });
  const app = { config: { personal: { spaceId: SPACE } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async () => task(),
      prepare: async (_token, value) => { stored = { ...value, phase: 'prepare' }; return task(); },
      checkpoint: async (_token, value) => { stored = { ...stored, ...value, phase: 'complete' }; return task(); } },
    personal: { conversation: async () => ({ status: 'saved', conversation_id: 'synthetic-conversation' }),
      getProjectAgent: async () => lead(clients) } };
  return checkpointTaskKnowledge(app, { taskContextToken: begun.token, sourceApplication: 'antigravity',
    disposition: 'retain_nothing', reason: 'Synthetic work finished' });
}

test('an Agent hired before a client had its own source owns that client\'s MCP-only task to the checkpoint', async () => {
  const { app, tasks } = fixture(HIRED_BEFORE);
  const entry = await mcpEntry(app);
  assert.equal(entry.context.personal_project_id, PROJECT);
  assert.equal(entry.context.project_agent_id ?? null, 'synthetic-lead');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sourceApplication, 'antigravity');
  assert.equal(tasks[0].projectAgentId, 'synthetic-lead');
  const result = await checkpoint(tasks[0], HIRED_BEFORE);
  assert.equal(result.agent_receipt.owner.agent_id, 'synthetic-lead');
  assert.doesNotMatch(result.agent_receipt.markdown, /分配/);
});

test('a task that truly has no owner keeps the entry\'s reason in its checkpoint receipt', async () => {
  // The person narrowed this lead to one client; that choice still holds.
  const { app, tasks } = fixture(['codex']);
  const entry = await mcpEntry(app);
  assert.equal(entry.context.personal_project_id, PROJECT);
  assert.equal(entry.context.project_agent_id ?? null, null);
  assert.match(entry.agent_receipt.markdown, /FULI Agent：分配失败（指定 FLA 不可用）/);
  const result = await checkpoint(tasks[0], ['codex']);
  assert.equal(result.agent_receipt.owner, null);
  assert.match(result.agent_receipt.markdown, /^FULI Agent：分配失败（指定 FLA 不可用）/);
  assert.doesNotMatch(result.agent_receipt.markdown, /任务没有可用负责人/);
});
