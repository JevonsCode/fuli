import assert from 'node:assert/strict';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { listAgentTools } from '../src/agent-tools.js';
import { MCP_CHAT_INSTRUCTIONS, MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { hookAdditionalContextToolResult } from '../src/mcp/tool-result.js';
import { sessionFuliOffContext } from '../src/conversations/session-fuli-entry.js';
import { PASS_TASK_TOKEN } from '../src/agents/lifecycle-message.js';
import { withCodexReviewGuidance } from '../src/agents/codex/review-command.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { taskAgentReceipt } from '../src/agents/identity-receipt.js';
import { readTurnReceipt } from '../src/agents/turn-receipt.js';
import { dataFormatReceiptNotice } from '../src/data-format/format-notices.js';
import { sessionMigrationLine, sessionMigrationOffer } from '../src/graphiti/session-knowledge-migration.js';

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
  // Agent apps (rec#7 part 1): submit_agent_app_version and list_agent_apps, full profile only, chat reaches them via fuli_call (+1,847 B; D-06 wording -4 B).
  // Bole dismissal (rec#8): dismiss_project_agent asks why first, plus list_agent_dismissal_lessons and get_agent_handoff (+1,740 B).
  // rec#8 model backends part 1: full-profile get_model_usage reads the model usage ledger and budget windows (+629 B).
  // Bole score card: get_agent_score_card serves the card and its task IDs in one tool (+1,065 B).
  // rec#5 C2: capture-policy tools take the caller's directory and the project mode (+1,215 B).
  // rec#8 part 2 (D-04 §2): full-profile role_work lets the current session answer a built-in Agent's handed-off work package instead of FULI starting a CLI; review_with_tonborg names that path (+1,009 B).
  // rec#5 section 3 tags: resolve_knowledge_tags and one change_knowledge_tags for create/alias/attach/detach, full profile only, chat reaches them via fuli_call (+1,945 B; D-07 review wording +128 B).
  // Merged: 172,573 -> 182,147 B (+9,574 B), measured. Chat is unchanged.
  // rec#5 C3: update_capture_policy takes sessionPaused and the task token, so "这次别记" pauses
  // one session without a new tool (+319 B). Chat, instructions and entry are unchanged.
  // rec#5 C3 review: usage, feedback and get_capture_policy take the task token, the only
  // identity besides the host session that can allow a write (+280 B): 182,147 -> 182,746 B, measured.
  // rec#5 C3b option Y (#251 review): 17 tools an Agent calls without a task of their own (entry,
  // recall, team and judgment reads) take an optional bare taskContextToken, so a call from a window
  // whose session is on is served while another window of the client is stopped; without it the
  // call cannot be attributed and is refused: 182,746 -> 183,375 B (+629 B), measured.
  // rec#20: remember takes scope unsure, so an item whose scope the user left open waits in the
  // session's temporary project instead of being guessed global: 183,375 -> 183,425 B (+50 B), measured.
  // rec#5 C4: update_capture_policy takes recordProjects (one project's switch, "这个项目以后别记了").
  // A long-term change is only asked for: the tool returns FULI's sentence and a console link, and
  // the person confirms in the console (rec#11 D-16), so the tool takes no confirmation field and
  // its description drops the example sentence: 183,425 -> 183,502 B (+77 B), measured (the
  // two-call previewToken design before D-16 was 183,719 B). Chat, instructions and entry unchanged.
  // rec#5 C6: full-profile read_session_records answers "这次都记了我什么" with the session's
  // numbered records (chat reaches it through list_agent_interfaces/fuli_call): 183,502 -> 184,107 B
  // (+605 B), measured after merging C4. Chat, instructions and entry are unchanged.
  // rec#5 C7/C8: revise_personal_knowledge names mark_outdated and says a correction is a new
  // version (+44 B); entities and relationships of the two full capture tools take derivedFrom, the
  // current items a conclusion rests on, so it stops being current with them (C8-4, +616 B):
  // 184,107 -> 184,767 B (+660 B), measured. Chat, instructions and entry are unchanged.
  // rec#11 D-07 part 2: change_knowledge_tags only previews the person's tag
  // governance (five actions, intoTagId), no new tool: 184,767 -> 184,935 B
  // (+168 B), measured. Chat, instructions and entry are unchanged.
  // rec#15 D-27.8 (dot P2 on #291): remember takes the user's stated constraint (hard|soft),
  // workKind and tasteDomain, checked against the versioned scene table server-side so the
  // schema lists no table: 184,935 -> 185,077 B (+142 B), measured.
  // rec#29 F2: one full-profile tool, register_standing_assignment, previews and confirms the
  // person's "from now on this work goes to that project" (chat reaches it through
  // list_agent_interfaces/fuli_call): 185,077 -> 186,372 B (+1,295 B), measured. Chat,
  // instructions and entry are unchanged.
  // rec#29 F5: the same tool takes change retire|reassign|edit_terms with term, leadAgentId,
  // addTerms and removeTerms instead of a second tool (measured: a separate correction tool
  // would add ~1,170 B): 186,372 -> 186,914 B (+542 B), measured. Chat, instructions and entry
  // are unchanged.
  fullToolSchemaBytes: 186914,
  // T-P00-2: the chat profile is what an ordinary task uses (entry fallback,
  // recall, checkpoint) plus list_agent_interfaces and the fuli_call
  // dispatcher; checkpoint lists capture compactly. Measured from the real
  // tools/list: 30,047 -> 7,782 B (-74%).
  // P6: explicit optional routine closure, 7,782 -> 7,722 B (real SDK list).
  // F-P0-08: the same `remember` items are listed in chat (+469 B, about 120
  // tokens per request). Without them a native haiku run failed five times on
  // the referenced capture shape and wrote nothing to FULI.
  // rec#5 C3b option Y: the same field on get_collaboration_preferences and the two searches:
  // 8,191 -> 8,302 B (+111 B), measured from the real tools/list.
  // rec#20: the same remember scope unsure, 8,302 -> 8,311 B (+9 B), measured.
  // rec#15 D-27.8: the same remember constraint/workKind/tasteDomain, 8,311 -> 8,426 B
  // (+115 B), measured bytes from the real tools/list.
  chatToolSchemaBytes: 8426,
  instructionsBytes: 2041,
  // T-P00: the chat profile's own instructions name only listed tools, so a
  // client no longer spends a request on discovery first: 2,041 -> 1,251 B.
  // P6: keep the new chat instructions conditional, 1,251 -> 1,238 B.
  chatInstructionsBytes: 1238,
  // T-TOKEN-2: the entry receipt keeps only what must be copied, defaults and
  // empty values are omitted, and the scope, receipt and details rule text is
  // referenced: 3,449 -> 1,775 chars.
  // An unsaved conversation names its failed step and error code; this synthetic
  // entry has no conversation store, so it always carries them: 1,775 -> 1,820
  // chars, measured. A saved conversation carries neither.
  projectEntryChars: 1820,
  // rec#5 C3b: a turn of a session FULI is off for gets this one line instead of the project
  // entry (its longest reason, measured): no memory, preferences, recall or receipt. Every
  // other number above is unchanged; the switch adds no tool, schema or instruction text.
  sessionOffEntryChars: 302,
  // rec#5 C3b option Y: the per-turn Claude Code and Codex hook label asks for the token the Agent
  // already has, instead of a sentence in the server instructions (which must stay under 2 KiB).
  taskTokenHintChars: 42,
  // rec#20 per-turn receipt, measured on the receipt a reply copies. A turn that saved nothing
  // new (small talk, a duplicate, a usage-only weight change) adds nothing at all; a turn that
  // saved items adds one heading (14 chars) and one line per item (152 chars for a short
  // preference, its edit link included, about 70 of them the link). A long receipt
  // stops near 1,800 characters and links the rest.
  // rec#5 C6: the heading of a turn that saved items links the session's record list in its
  // short form, `（[本会话已记录](<…/s/<session>>)）`: the console reads it in its active space
  // and the Provider finds the session's client. Measured with a UUID session on the default
  // console: 14 -> 88 chars (+74, about 25 tokens, only on a turn that saved items; the first
  // form with space and client in the path was +130 with a real UUID space).
  turnReceiptNoChangeChars: 0,
  turnReceiptHeadingChars: 88,
  turnReceiptEntryChars: 152,
  // rec#22: only a Codex turn the person starts with an exact `fuli review` line gets this
  // one line (with its separator) after the task entry; the always-loaded Codex bootstrap
  // dropped its dead `/flreview` bridge for it (962 -> 910 B).
  codexReviewGuidanceBytes: 101,
  // rec#17 part 2: the receipt's data format notice, with its separator. Nothing waits and nothing
  // was applied in the last day: no bytes at all. One step waiting for a person, or one migration
  // applied: one short line naming the step (and the read-only preview command).
  migrationReceiptNoneChars: 0,
  migrationReceiptPendingChars: 62,
  migrationReceiptAppliedChars: 40,
  // rec#20 part 2: the link to a session's batch migration, with its separator. Nothing waits, or
  // the session already worked in this project: no bytes. The session's first task in a formal
  // project while its temporary project holds items: one line with the count (152 chars with a
  // UUID session, about 105 of them the link). A turn in a formal project that left items
  // undecided: one line after its receipt (149 chars). No tool, schema or instruction text.
  sessionMigrationNoneChars: 0,
  sessionMigrationOfferChars: 152,
  sessionMigrationTurnChars: 149
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
    projectEntryChars: await projectEntryChars(),
    sessionOffEntryChars: Math.max(...['session_stopped', 'session_not_started', 'session_start_unsaved', 'policy_unavailable']
      .map(reason => sessionFuliOffContext({ reason }).length)),
    taskTokenHintChars: PASS_TASK_TOKEN.length,
    codexReviewGuidanceBytes: codexReviewGuidanceBytes(), ...await turnReceiptChars(), ...await migrationReceiptChars(),
    ...await sessionMigrationChars() };
}

// rec#20 part 2: the migration link line with its separator, measured with a UUID session
// on the default console, from a synthetic Provider answer.
async function sessionMigrationChars() {
  const task = { sessionId: '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84', sourceApplication: 'claude_code',
    personalProjectId: 'sample' };
  const offer = async pending => (await sessionMigrationOffer({ config: { personal: { spaceId: 'space' } },
    personal: { previewSessionMigration: async () => pending } }, task))?.length ?? -1;
  return { sessionMigrationNoneChars: 1 + await offer({ held_count: 0, linked_task_count: 1 }),
    sessionMigrationOfferChars: 1 + await offer({ held_count: 12, linked_task_count: 1 }),
    sessionMigrationTurnChars: 1 + sessionMigrationLine({ config: { personal: { spaceId: 'space' } } }, task).length };
}

function codexReviewGuidanceBytes() {
  const entry = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'entry' } };
  return Buffer.byteLength(withCodexReviewGuidance(entry).hookSpecificOutput.additionalContext, 'utf8')
    - Buffer.byteLength(entry.hookSpecificOutput.additionalContext, 'utf8');
}

// The receipt's data format notice from synthetic notices and operations, through the identity receipt.
async function migrationReceiptChars() {
  const app = { config: { personal: { spaceId: 'space' } } };
  const owner = { projectId: 'sample', agentId: 'lead-sample', name: 'Synthetic lead' };
  const plain = taskAgentReceipt(app, owner).markdown;
  const added = async (notices, operations) => {
    const dataFormatNotice = dataFormatReceiptNotice('/synthetic', { notices: () => notices,
      operations: () => operations, now: () => Date.parse('2026-10-21T00:00:00Z') });
    const notice = await dataFormatNotice();
    const receipt = taskAgentReceipt(app, { ...owner, notices: notice ? [notice] : [] });
    return receipt.markdown.length - plain.length;
  };
  const step = 'task-schedules/3-run-recovery';
  return { migrationReceiptNoneChars: await added([], []),
    migrationReceiptPendingChars: await added([{ store: 'task-schedules', label: 'task-schedules.sqlite',
      state: 'pending_confirmation', steps: [step] }], []),
    migrationReceiptAppliedChars: await added([], [{ kind: 'applied', migrationId: step, at: '2026-10-20T12:00:00Z' }]) };
}

// A synthetic turn through the real receipt renderer and the identity receipt it follows.
async function turnReceiptChars() {
  const entry = { item_kind: 'entity', item_id: '00000000-0000-4000-8000-000000000000', change: 'created',
    category: 'taste', content: '回复先给结论，再给细节', title: 'Synthetic', type: 'PersonalPreference',
    scope: { kind: 'global', projects: [], status: 'set' }, tags: [], confirmation_status: 'pending',
    content_source: 'agent_inferred', weight: { percent: 12, basis: { confirmed_by_person: false,
      qualified_use_count: 0, source_count: 1 } } };
  const app = { config: { personal: { spaceId: 'space' } },
    personal: { readTurnReceipt: async () => ({ entries: [entry] }) } };
  const owner = { projectId: 'sample', agentId: 'lead-sample', name: 'Synthetic lead' };
  const plain = taskAgentReceipt(app, owner).markdown;
  const unchanged = taskAgentReceipt(app, { ...owner, turnReceipt: await readTurnReceipt(app, []) }).markdown;
  const [heading, line] = (await readTurnReceipt(app, [{ status: 'committed', episode_id: 'episode' }],
    { session: { sourceApplication: 'claude_code', sessionId: '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84' } })).lines;
  return { turnReceiptNoChangeChars: unchanged.length - plain.length,
    turnReceiptHeadingChars: heading.length, turnReceiptEntryChars: line.length };
}

test('per-session token cost never grows past the recorded baseline', async () => {
  const current = await measure();
  for (const [key, limit] of Object.entries(BASELINE)) {
    assert.ok(current[key] <= limit, `${key} grew to ${current[key]} (baseline ${limit}); shrink it or justify a new baseline`);
  }
});
