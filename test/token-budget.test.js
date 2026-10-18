import assert from 'node:assert/strict';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { listAgentTools } from '../src/agent-tools.js';
import { toolNamesForProfile } from '../src/mcp/tool-profiles.js';
import { MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { hookAdditionalContextToolResult } from '../src/mcp/tool-result.js';

// R-13 token gate: what every session pays before doing any work. A change
// that grows a number fails here; lower the baseline when a change shrinks it,
// and raise it only with the reason in the same commit.
const BASELINE = Object.freeze({
  // R-02: +1,730 B for required occupation contracts on full-profile writers.
  // The default chat schema and task entry budgets remain unchanged.
  // T-TOKEN-1: chat drops capture_session_knowledge and record_decision_trace
  // (both on demand via list_agent_interfaces) and the repeated profileAspect
  // text shrinks: chat -12,291 B, full -2,004 B; instructions -2 B while adding
  // the pointer that tells chat clients how to reach unlisted tools.
  // UI-09 adds one required chat-operation contract and discovery filters:
  // +1,836 B in each profile. With dependency #103, both remain below the
  // pre-refactor 169,321/40,502 B; task entry and instructions do not grow.
  fullToolSchemaBytes: 169153,
  chatToolSchemaBytes: 30047,
  instructionsBytes: 2041,
  projectEntryChars: 3449
});

const schemaBytes = tools => Buffer.byteLength(JSON.stringify(tools.map(({ name, title, description, inputSchema }) =>
  ({ name, title, description, inputSchema }))));

// Synthetic project entry through the real preference workflow and the Claude
// Code hook delivery path; no live Provider.
async function projectEntryChars() {
  const project = { project_id: 'sample', scope_type: 'registered', profile: { name: 'Sample' } };
  const lead = { agent_id: 'lead-sample', personal_space_id: 'space', personal_project_id: 'sample',
    profile: { name: 'Synthetic lead', status: 'active', allowed_clients: ['claude_code'],
      work_kinds: ['project_context'], capabilities: [] } };
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token',
    principalId: 'synthetic-user', spaceId: 'space'
  }, workspaces: [] }, { projectPathResolver: () => ({ status: 'matched', personalProjectId: 'sample' }),
    fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
  app.taskContextRegistry = { current: async () => null,
    begin: async input => ({ ...input, token: 'fuli-task-synthetic-budget' }) };
  Object.assign(app.personal, {
    listPersonalProjects: async () => [project], listProjectAgentAssignments: async () => [],
    getPersonalProject: async () => project,
    resolveProjectAgentContext: async () => ({ status: 'ready', agent: lead }),
    collaborationPreferences: async (space, projectId, limit, agent) => ({ personal_space_id: space,
      personal_project_id: projectId, project_agent_id: agent, effective_preferences: [],
      global_preferences: [], conflicts: [], truncated: false, source_windows: { candidates_truncated: false,
        project_ancestors_truncated: false, queued_conflicts_truncated: false } }),
    listPreferenceConflicts: async () => [], getProjectAgentCoordinationPolicy: async () => ({}),
    listProjectAgents: async () => [], listProjectAgentTasks: async () => []
  });
  app.searchKnowledge = async () => ({ facts: [], entities: [] });
  const entry = await app.getCollaborationPreferences({ projectPath: '/synthetic/sample',
    sourceApplication: 'claude_code', sourceSessionId: 'synthetic-host', sessionId: 'synthetic-session',
    taskPrompt: 'Synthetic task', agentInvocation: true, agentToolName: 'get_collaboration_preferences' });
  const delivered = hookAdditionalContextToolResult(compactTaskContext(entry), { hookEventName: 'UserPromptSubmit',
    label: 'Synthetic budget entry', limitBytes: 128 * 1024, itemLimit: 1000 });
  return JSON.parse(delivered.content[0].text).hookSpecificOutput.additionalContext.length;
}

async function measure() {
  const all = listAgentTools();
  const chat = toolNamesForProfile('chat');
  return { fullToolSchemaBytes: schemaBytes(all),
    chatToolSchemaBytes: schemaBytes(all.filter(({ name }) => chat.includes(name))),
    instructionsBytes: Buffer.byteLength(MCP_INSTRUCTIONS, 'utf8'),
    projectEntryChars: await projectEntryChars() };
}

test('per-session token cost never grows past the recorded baseline', async () => {
  const current = await measure();
  for (const [key, limit] of Object.entries(BASELINE)) {
    assert.ok(current[key] <= limit, `${key} grew to ${current[key]} (baseline ${limit}); shrink it or justify a new baseline`);
  }
});
