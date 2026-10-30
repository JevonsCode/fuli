import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { listAgentTools } from '../src/agent-tools.js';
import { MCP_CHAT_INSTRUCTIONS, MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { hookAdditionalContextToolResult } from '../src/mcp/tool-result.js';
import { sessionFuliOffContext } from '../src/conversations/session-fuli-entry.js';
import { PASS_TASK_TOKEN, taskClosingInstruction } from '../src/agents/lifecycle-message.js';
import { withCodexReviewGuidance } from '../src/agents/codex/review-command.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { taskAgentReceipt } from '../src/agents/identity-receipt.js';
import { readTurnReceipt } from '../src/agents/turn-receipt.js';
import { dataFormatReceiptNotice } from '../src/data-format/format-notices.js';
import { sessionMigrationLine, sessionMigrationOffer } from '../src/graphiti/session-knowledge-migration.js';
import { OMITTED_PREFERENCES_LABEL } from '../src/conversations/entry-inline-budget.js';
import { claudeEntrySession, syntheticLargeEntry, syntheticPreferences } from '../test-support/synthetic-large-entry.js';

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
  // 0.20.1 FLA read boundary, merged from release/0.20 (#344/#345): get_knowledge_graph takes
  // projectAgentId, the FLA it reads as, since another reader no longer sees an FLA's own
  // knowledge (+122 B on release); a conflict naming an FLA's item is missing to any other reader,
  // so resolve_deferred_preference_conflict and defer_preference_conflict name the FLA too
  // (+284 B on release): 186,914 -> 187,320 B (+406 B), measured on main after the merge.
  // rec#47 F2, merged from release/0.20 (#349): the 7 records a task writes as it goes or closes
  // (capture, decision trace, workflow observation, Agent memory checkpoint, task activity,
  // executor actual, task outcome) take the same optional bare taskContextToken, without which
  // they were always refused while any session of the client was stopped (+259 B on release):
  // 187,320 -> 187,579 B, measured on main after the merge. Chat is unchanged.
  // rec#50, merged from release/0.20 (#367): list_judgments returns decisions without their words
  // and shows a reviewed item only to a reader who may see it now, so it takes projectAgentId as the
  // other FLA reads do and says so (+133 B on release): 187,579 -> 187,712 B, measured on main after
  // the merge. Chat is unchanged.
  // rec#11 D-62: every gated tool (all but the open ones) takes the optional bare taskContextToken
  // instead of a list of 24, since a read like list_judgments was always refused while any session
  // of the client was stopped and the model could not pass the token its schema rejected. 102 more
  // tools list the field; those that name a task token keep their own: 187,712 -> 191,482 B
  // (+3,770 B, about 37 B a tool), measured. Chat is unchanged: its listed tools already took it or are
  // open, and fuli_call reads one schema on demand.
  // rec#11 D-64: OpenCode's own source application, so its hook tasks, capture switch and allowed
  // clients stop being shared with every `other` client: "opencode" joins each source enum the full
  // profile lists (about 11 B each): 191,482 -> 191,691 B (+209 B), measured. Chat is unchanged.
  // D-64 capture isolation: optional capturedSources lets OpenCode override only
  // the legacy other alias without enabling generic clients: +262 B, measured.
  // Chat, instructions and entry are unchanged.
  // Task schedules removed (owner's decision, 2026-10-27): manage_project_agent_schedule leaves
  // the full profile: 191,953 -> 190,325 B (-1,628 B), measured. Chat is unchanged.
  // rec#55 @FLG: one new roundtable tool, group_discussion, which the moderating Agent calls only
  // after the person confirms members: 190,325 -> 191,468 B (+1,143 B), measured. Chat, instructions
  // and an ordinary entry are unchanged.
  // rec#11 D-71 服务管理: one full-profile tool, report_agent_service, registers or updates a
  // server an Agent started (chat reaches it through list_agent_interfaces/fuli_call):
  // 191,468 -> 192,460 B (+992 B, measured). Chat, instructions and entry are unchanged.
  // 更好的项目管理: create_project_agent_assignment takes an optional projectManager (the Agent
  // becomes the project's own PM; its board's shape lives in Jefa's configure_project_board, read
  // on demand): 192,460 -> 192,809 B (+349 B), measured. Chat, instructions and entry are unchanged.
  // Agent 取名风格: one full-profile read, get_agent_naming_style, that a recruiting Agent calls only
  // right before proposing a new Agent's name (the style is never put in an entry), and a one-line
  // displayName pointer to it in the three schemas that create Agents: 192,809 -> 193,488 B (+679 B),
  // measured. Chat, instructions and entry are unchanged.
  // Search index view (claude-mem's index-then-fetch): search_knowledge_graph and
  // search_current_project_knowledge take optional view and ids, so an Agent reads chosen records
  // instead of paging every full one. Descriptions stay as they were: an overflowing page's
  // continuation_guidance names the index view when it is useful. 193,488 -> 193,798 B (+310 B),
  // measured. Instructions and entry are unchanged.
  // rec#60 D-78 Agent workflows: four full-profile tools (propose, index, read, record a run), each
  // bound to the task's Agent by its token; workflows themselves are never put into a context, the
  // index names each one's approxTokens and one is read only when needed (chat reaches them through
  // list_agent_interfaces/fuli_call): 193,798 -> 196,089 B (+2,291 B), measured. Chat, instructions
  // and entry are unchanged.
  fullToolSchemaBytes: 196089,
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
  // Search index view: the same optional view and ids on search_current_project_knowledge,
  // 8,426 -> 8,641 B (+215 B, about 55 tokens a request), measured from the real tools/list.
  chatToolSchemaBytes: 8641,
  // rec#51: "noMatchSourceMarker (empty) if searched", since an MCP-only client that never searched
  // opened its answer with "已检索，未命中"; "then" dropped from "Active child first, then": 2,041 ->
  // 2,048 B (+7 B), measured. This is Claude Code's 2 KiB cap, so the next addition must shrink.
  instructionsBytes: 2048,
  // T-P00: the chat profile's own instructions name only listed tools, so a
  // client no longer spends a request on discovery first: 2,041 -> 1,251 B.
  // P6: keep the new chat instructions conditional, 1,251 -> 1,238 B.
  // rec#51: the same " if searched", 1,238 -> 1,250 B (+12 B), measured.
  chatInstructionsBytes: 1250,
  // T-TOKEN-2: the entry receipt keeps only what must be copied, defaults and
  // empty values are omitted, and the scope, receipt and details rule text is
  // referenced: 3,449 -> 1,775 chars.
  // An unsaved conversation names its failed step and error code; this synthetic
  // entry has no conversation store, so it always carries them: 1,775 -> 1,820
  // chars, measured. A saved conversation carries neither.
  projectEntryChars: 1820,
  // rec#51 D-59: a coding task (a change request naming a distinctive term) whose exact project
  // holds matching knowledge gets a title-only knowledge_index in its recall: [id, title] pairs, the
  // count that one bounded search kept and one read line, never a body. Measured over the same
  // entry for a task that searches nothing, with UUID ids and synthetic titles of 22-45 bytes (cut
  // at 40): no match adds nothing at all (the recall is byte for byte the not_needed one); one
  // match +226 chars, five +529 (about 130 tokens), of which the read line is 108. #368 review:
  // the count is named matched_in_search and the line says the titles come from one bounded
  // search, not the project's total (+27 chars from 199/502). A task with recall intent, and
  // every other task, is unchanged.
  knowledgeIndexNoneChars: 0,
  knowledgeIndexOneChars: 226,
  knowledgeIndexFiveChars: 529,
  // rec#5 C3b: a turn of a session FULI is off for gets this one line instead of the project
  // entry (its longest reason, measured): no memory, preferences, recall or receipt. Every
  // other number above is unchanged; the switch adds no tool, schema or instruction text.
  sessionOffEntryChars: 302,
  // rec#5 C3b option Y: the per-turn Claude Code and Codex hook label asks for the token the Agent
  // already has, instead of a sentence in the server instructions (which must stay under 2 KiB).
  taskTokenHintChars: 42,
  // rec#47 F1: the Claude Code and Codex hook labels say how the task closes, with the token
  // and receipt markdown, because the entry only references the checkpoint and receipt rules
  // and Claude Code shows a long entry as a file preview, in which a tester's model searched
  // its own hook output five times for them (+215% input tokens). Measured on the synthetic
  // project entry, its token and receipt link included: 326 chars. The labels drop "Read full
  // context" and "Follow checkpoint_guidance: …" (Claude Code -144, Codex -132 chars), so a
  // turn's label grows by about 190 chars, about 50 tokens; a longer token or agent name adds
  // its own length.
  entryClosingChars: 326,
  // rec#47 F1b, rec#11 D-54: Claude Code keeps only a preview of a hook context over about
  // 10,000 chars, so its entry is bounded to 9,000 and stays a confirmable frame. Measured on the
  // synthetic 60-preference entry (test-support/synthetic-large-entry.js, about 430 chars each,
  // 5 hard rules that always stay and 2 boundaries ranked first, D-69): turn 1 was 37,509
  // chars, every turn, and is now one complete frame of
  // 11 preferences plus the omitted count; turn 2 was again 37,509 and is now a delta. A frame
  // that leaves preferences out adds one label sentence (with its space). Entries that fit, and
  // every other Agent, are unchanged.
  claudeBoundedEntryChars: 8775,
  claudeBoundedNextTurnChars: 2191,
  omittedPreferencesLabelChars: 132,
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
  // Data-format completion reminders add the remaining count and local dismissal link:
  // 37 -> 104 characters, only for up to seven task receipts per completed migration.
  migrationReceiptNoneChars: 0,
  migrationReceiptPendingChars: 59,
  migrationReceiptAppliedChars: 104,
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

// Synthetic project entry through the real preference workflow, compacted as
// the hook delivers it; no live Provider.
async function projectEntry({ taskPrompt = 'Synthetic task', found = { facts: [], entities: [] } } = {}) {
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
  // `found` answers the index search alone: the lead's continuity search is not what is measured.
  app.searchKnowledge = async ({ agentToolName }) => agentToolName === 'automatic_task_knowledge_index'
    ? found : { facts: [], entities: [] };
  const entry = await app.getCollaborationPreferences({ projectPath: '/synthetic/sample',
    sourceApplication: 'claude_code', sourceSessionId: 'synthetic-host', sessionId: 'synthetic-session',
    taskPrompt, agentInvocation: true, agentToolName: 'get_collaboration_preferences' });
  return compactTaskContext(entry);
}

const deliveredChars = entry => JSON.parse(hookAdditionalContextToolResult(entry, { hookEventName: 'UserPromptSubmit',
  label: 'Synthetic budget entry', limitBytes: 128 * 1024, itemLimit: 1000 }).content[0].text)
  .hookSpecificOutput.additionalContext.length;

// The entry through the Claude Code hook delivery path, and the closing line
// its real label adds.
async function projectEntryChars() {
  const entry = await projectEntry();
  return { projectEntryChars: deliveredChars(entry), entryClosingChars: taskClosingInstruction(entry).length };
}

// rec#51 D-59: what a coding task's entry adds for 0, 1 and 5 matching items of
// its project, over the same entry for a task that searches nothing. UUID ids
// and synthetic titles of 22 to 45 bytes, as stored names run.
const INDEX_TITLES = ['find_agents term matching', 'find_agents matches terms in both directions',
  'Roundtable boundary for find_agents', 'find_agents warning wording', 'find_agents result order rule',
  'find_agents never imports FULI'];
async function knowledgeIndexChars() {
  const base = deliveredChars(await projectEntry());
  const added = async count => deliveredChars(await projectEntry({ taskPrompt: 'Fix find_agents so terms match as whole words',
    found: { facts: [], entities: INDEX_TITLES.slice(0, count).map((name, index) => ({
      id: `0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b${String(index).padStart(2, '0')}`, space_id: 'space', scope: 'personal',
      name, type: 'Rule', summary: `SYNTHETIC body ${index}: a rule about find_agents.`, defined_project_id: 'sample',
      scope_distance: 0, confirmation_status: 'confirmed', score: 1 })) } })) - base;
  return { knowledgeIndexNoneChars: await added(0), knowledgeIndexOneChars: await added(1),
    knowledgeIndexFiveChars: await added(5) };
}

// Two turns of the synthetic 60-preference entry through the real Claude Code
// hook and session cache, the first recorded as the host records it.
function claudeBoundedEntryChars() {
  return claudeEntrySession(async session => {
    const items = syntheticPreferences(60);
    const [first, next] = [await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-1' })),
      await session.turn(syntheticLargeEntry({ items, sessionId: session.sessionId, token: 'task-2' }))];
    return { claudeBoundedEntryChars: first.text.length, claudeBoundedNextTurnChars: next.text.length };
  });
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
    ...await projectEntryChars(), ...await knowledgeIndexChars(), ...await claudeBoundedEntryChars(),
    omittedPreferencesLabelChars: 1 + OMITTED_PREFERENCES_LABEL.length,
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
  const root = mkdtempSync(join(tmpdir(), 'fuli-notice-budget-'));
  const added = async (notices, operations) => {
    const dataFormatNotice = dataFormatReceiptNotice(root, { notices: () => notices,
      operations: () => operations, now: () => Date.parse('2026-10-21T00:00:00Z') });
    const notice = await dataFormatNotice({ taskId: 'budget-task', closeUrl: 'http://127.0.0.1:2727/settings/data-format' });
    const receipt = taskAgentReceipt(app, { ...owner, notices: notice ? [notice] : [] });
    return receipt.markdown.length - plain.length;
  };
  const step = 'agent-apps/7-identity-keys';
  try {
    return { migrationReceiptNoneChars: await added([], []),
      migrationReceiptPendingChars: await added([{ store: 'agent-apps', label: 'agent-apps/registry.sqlite',
        state: 'pending_confirmation', steps: [step] }], []),
      migrationReceiptAppliedChars: await added([], [{ kind: 'applied', migrationId: step, at: '2026-10-20T12:00:00Z' }]) };
  } finally { rmSync(root, { recursive: true, force: true }); }
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
