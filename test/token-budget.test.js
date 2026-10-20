import assert from 'node:assert/strict';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { listAgentTools } from '../src/agent-tools.js';
import { MCP_CHAT_INSTRUCTIONS, MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { hookAdditionalContextToolResult } from '../src/mcp/tool-result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

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
  // Settings guide: explain_settings is full-profile only (chat reaches it
  // through list_agent_interfaces/fuli_call): 168,566 -> 169,002 B (+436 B).
  // P6: checkpoint guidance becomes conditional; descriptions shrink 195 B.
  // F-P0-08: checkpoint takes `remember` (preference / project_fact items the
  // server routes) because models could not build the referenced capture shape
  // and saved nothing natively: 168,807 -> 169,269 B (+462 B).
  // RT-1: agent_chat (full profile only) gains action wait with its cursor and
  // timeout so an Agent waits for pushed messages instead of polling:
  // 169,269 -> 169,425 B (+156 B). The chat profile is unchanged.
  // F-P2-05 ⑤: coordinate/submit take start:false to assign a task to the
  // backlog without starting a worker, and the status enums gain backlog:
  // 169,425 -> 169,565 B (+140 B). The chat profile is unchanged.
  // F-P2-05 ⑥: one full-profile tool, manage_project_agent_schedule, covers
  // scheduled tasks and their circuit breaker (create/update/pause/resume/list/
  // runs share one schema): 169,565 -> 171,156 B (+1,591 B). Chat is unchanged.
  // F-P2-05 ⑦: one full-profile tool, control_project_agent_task_run, stops a
  // run, retries a terminal task as new work or replays run history:
  // 171,156 -> 172,214 B (+1,058 B). Chat is unchanged.
  // The same tool takes the host task context (token, application, session)
  // so a grouped team's stop/retry passes the check its submissions pass:
  // 172,214 -> 172,415 B (+201 B). Chat is unchanged.
  // Attention replies: request_agent_attention says to ask in the live
  // conversation first (the console is the away inbox) and read_agent_messages
  // names the answers it now returns: 172,415 -> 172,573 B (+158 B). Chat is unchanged.
  // Agent apps (rec#7 part 1): submit_agent_app_version and list_agent_apps, full profile only, chat reaches them via fuli_call: +1,847 B.
  // rec#5 C2: get_capture_policy takes the caller directory; update_capture_policy asks to restate and confirm long-term changes: +1,215 B.
  // Merged: 172,573 -> 175,635 B (+3,062 B). The chat profile is unchanged.
  fullToolSchemaBytes: 175635,
  // T-P00-2: the chat profile is what an ordinary task uses (entry fallback,
  // recall, checkpoint) plus list_agent_interfaces and the fuli_call
  // dispatcher; checkpoint lists capture compactly. Measured from the real
  // tools/list: 30,047 -> 7,782 B (-74%).
  // P6: explicit optional routine closure, 7,782 -> 7,722 B (real SDK list).
  // F-P0-08: the same `remember` items are listed in chat (+469 B, about 120
  // tokens per request). Without them a native haiku run failed five times on
  // the referenced capture shape and wrote nothing to FULI.
  chatToolSchemaBytes: 8191,
  instructionsBytes: 2041,
  // T-P00: the chat profile's own instructions name only listed tools, so a
  // client no longer spends a request on discovery first: 2,041 -> 1,251 B.
  // P6: keep the new chat instructions conditional, 1,251 -> 1,238 B.
  chatInstructionsBytes: 1238,
  // T-TOKEN-2: the entry receipt keeps only what must be copied, defaults and
  // empty values are omitted, and the scope, receipt and details rule text is
  // referenced: 3,449 -> 1,775 chars.
  projectEntryChars: 1775
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

// What a chat client actually receives from tools/list, dispatcher included.
async function listedChatBytes() {
  const server = createMcpServer({}, { env: {}, toolProfile: 'chat', registerResources: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'budget', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return Buffer.byteLength(JSON.stringify(tools.map(({ name, title, description, inputSchema }) =>
    ({ name, title, description, inputSchema }))));
}

async function measure() {
  const all = listAgentTools();
  return { fullToolSchemaBytes: schemaBytes(all),
    chatToolSchemaBytes: await listedChatBytes(),
    instructionsBytes: Buffer.byteLength(MCP_INSTRUCTIONS, 'utf8'),
    chatInstructionsBytes: Buffer.byteLength(MCP_CHAT_INSTRUCTIONS, 'utf8'),
    projectEntryChars: await projectEntryChars() };
}

test('per-session token cost never grows past the recorded baseline', async () => {
  const current = await measure();
  for (const [key, limit] of Object.entries(BASELINE)) {
    assert.ok(current[key] <= limit, `${key} grew to ${current[key]} (baseline ${limit}); shrink it or justify a new baseline`);
  }
});
