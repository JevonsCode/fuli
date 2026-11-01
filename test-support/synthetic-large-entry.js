// A synthetic task entry with many preferences, for the Claude Code inline
// budget (rec#47 F1b, D-54). Every preference, message and conflict is made
// here; nothing is read from a real transcript or data directory.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { claudePreferenceEvidence } from '../src/agents/claude-code/preference-evidence.js';
import { createSessionPreferenceDelivery } from '../src/conversations/preference-session.js';
import { projectAgentCollaborationPreferences } from '../src/graphiti/collaboration-preference-workflow.js';
import { withPreferenceScope } from '../src/conversations/preference-snapshot.js';
import { syntheticHost, syntheticPreference } from './synthetic-context-session.js';
import { agentMemoryView } from '../src/graphiti/project-agent-memory.js';
import { PROJECT_AGENT_CONTINUITY_GUIDANCE } from '../src/graphiti/project-agent-task-entry.js';
import { TEAM_GUIDANCE } from '../src/graphiti/project-agent-team-context.js';
import { CONVERSATION_GUIDANCE } from '../src/graphiti/agent-conversations.js';
import { STOP_HOOK_CHECKPOINT_GUIDANCE, taskKnowledgeGuidance } from '../src/graphiti/task-knowledge-guidance.js';
import { TASK_KNOWLEDGE_RETRIEVAL_GUIDANCE } from '../src/graphiti/task-knowledge-recall.js';
import { createFuliSourceMarker } from '../src/graphiti/source-marker.js';
import { RECEIPT_GUIDANCE } from '../src/agents/identity-receipt.js';
import { employeeTaskEntry } from '../src/employees/task-entry.js';
import { finishTaskEntryPreferences, taskJudgmentContext } from '../src/graphiti/task-entry-preferences.js';

// Claude Code keeps a hook context longer than this only as a preview.
const CLAUDE_PREVIEW_CHARS = 10000;
const PREVIEW_HEAD_CHARS = 2000;

const SPACE = 'synthetic-space';
const PROJECT = 'project';
const AGENT = 'lead';
const SENTENCES = ['Keep the cursor stable across pages and say which field carries it. ',
  '导出接口需要保留分页游标，字段单位要写清楚。', 'Write the rollback plan into the review before merging. ',
  'Errors must point at the exact line and the input that caused them. ', '测试数据全部是合成的，不读真实目录。'];

// About 430 characters each, like the rec#47 sample. Every `hardEvery`-th one
// is a hard constraint, every `boundaryEvery`-th a boundary (a judgment rule
// without a scene key), every `sceneEvery`-th names the code scene; the rest
// are general taste.
export function syntheticPreferences(count, { hardEvery = 12, boundaryEvery = 20, sceneEvery = 4, length = 430 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const kind = number % hardEvery === 0 ? 'hard' : number % boundaryEvery === 0 ? 'boundary'
      : number % sceneEvery === 0 ? 'scene' : 'general';
    let instruction = `SYNTHETIC_${kind.toUpperCase()}_${number}: `;
    for (let sentence = index; instruction.length < length; sentence++) instruction += SENTENCES[sentence % SENTENCES.length];
    const qualifiers = kind === 'hard' ? { constraint: 'hard' } : kind === 'scene' ? { tasteDomain: 'code' } : {};
    const aspect = kind === 'boundary' || kind === 'hard' ? 'judgment_preference' : 'taste';
    return syntheticPreference(`rule-${number}`, instruction.slice(0, length), qualifiers, aspect);
  });
}

// A conversation recovery window of `count` messages, each about `length` characters.
export function syntheticRecovery(count, { length = 600, conversationId = 'conversation-large' } = {}) {
  return { conversation_id: conversationId, revision: count, summary: '', summary_role: 'historical', truncated: false,
    latest_checkpoint: null, omitted_sequence: null, scan_truncated: false,
    messages: Array.from({ length: count }, (_, index) => ({ sequence: index + 1, role: index % 2 ? 'assistant' : 'user',
      content: `SYNTHETIC message ${index + 1}: ${'Synthetic conversation text. '.repeat(Math.ceil(length / 29))}`.slice(0, length) })) };
}

// A matched automatic recall with `count` synthetic facts.
export function syntheticRecall(count, { length = 700 } = {}) {
  return { status: 'matched', partial: false, failed_query_count: 0, trigger_categories: ['prior_context'], query_count: 1,
    facts: Array.from({ length: count }, (_, index) => ({ uuid: `fact-${index + 1}`, relationship: 'SYNTHETIC',
      fact: `SYNTHETIC recalled fact ${index + 1}: ${'A recalled project fact. '.repeat(Math.ceil(length / 25))}`.slice(0, length) })),
    entities: [] };
}

// A coding task's title-only knowledge index (rec#51 D-59) with `count`
// synthetic [id, title] pairs, each title at the 40-byte limit.
export function syntheticIndexRecall(count) {
  return { status: 'indexed', trigger_categories: [], query_count: 1,
    knowledge_index: { matched_in_search: count, items: Array.from({ length: count }, (_, index) =>
      [`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, `SYNTHETIC indexed rule ${index + 1} title…`.padEnd(37, '.')]),
    read: 'Titles of one bounded search: read one with search_current_project_knowledge before relying on it.' },
    facts: [], entities: [] };
}

// begin_task_context as the Provider-backed producer returns it, before the
// hook compacts it: preferences filtered for the scene, the task token,
// receipt, one active conflict and the private scope the delivery cache binds.
export function syntheticLargeEntry({ items, sessionId, token = 'task-large', workKind = 'implementation',
  conversation = null, recall = null, conflicts = true }) {
  const projection = projectAgentCollaborationPreferences({ personal_space_id: SPACE, personal_project_id: PROJECT,
    project_agent_id: AGENT, effective_preferences: structuredClone(items), truncated: false,
    conflicts: conflicts ? [{ preference_key: 'indent', preference_scope: 'global', item_ids: ['conflict-a', 'conflict-b'] }] : [],
    global_preferences: conflicts ? [syntheticPreference('conflict-a', 'SYNTHETIC_CONFLICT_A: tabs.'),
      syntheticPreference('conflict-b', 'SYNTHETIC_CONFLICT_B: spaces.')].map((item, index) =>
      ({ ...item, id: index ? 'conflict-b' : 'conflict-a' })) : [],
    source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } },
  { personalProjectId: PROJECT }, { projectAgentId: AGENT, taskScope: { sessionId, workKind } });
  return withPreferenceScope({ ...projection, taskContextToken: token, task_context_token: token, checkpoint_required: true,
    agent_receipt: { required: true, markdown: `**[◇ FULI · Synthetic lead](http://127.0.0.1:4318/agents/${SPACE}/${AGENT})**` },
    context: { personal_project_id: PROJECT, project_agent_id: AGENT },
    ...(recall ? { task_knowledge_recall: recall } : {}),
    ...(conversation ? { conversation: { status: 'saved', conversation_id: conversation.conversation_id, recovery: conversation } } : {}) },
  { personal_space_id: SPACE, personal_project_id: PROJECT, project_agent_id: AGENT, session_id: sessionId,
    source_application: 'claude_code', preference_scope: { version: 1, work_kind: workKind, workflow: null } });
}

// A working project lead's begin_task_context, shaped like the Mac sample of rec#47
// (0.21.0-beta.2) had it: the hook closes the task, a persistent role with
// both memory layers and a directory snapshot, a small team, Jefa's managed
// board, Tonborg's automatic judgment, a matched recall and a saved
// conversation. Every guidance text comes from its real producer.
export async function syntheticWorkingEntry({ items, sessionId, token = 'fuli-task-6f1d2c3b-8a4e-4f5d-9b0c-1e2f3a4b5c6d' }) {
  const entry = syntheticLargeEntry({ items, sessionId, token, recall: { ...syntheticRecall(4, { length: 280 }),
    guidance: TASK_KNOWLEDGE_RETRIEVAL_GUIDANCE, sourceMarker: createFuliSourceMarker({
      facts: [{ uuid: 'fact-1', fact: 'SYNTHETIC recalled fact 1', personal_project_id: PROJECT }] }),
    noMatchSourceMarker: createFuliSourceMarker({}) },
  conversation: syntheticRecovery(4, { length: 400 }) });
  const management = await syntheticManagement();
  const judgment = await taskJudgmentContext({ config: { personal: { spaceId: SPACE } }, judgment: { policy: async () =>
    ({ mode: 'auto', quality: 'quality', client: 'claude_code', revision: 3, globalRevision: 2, inherited: false, personalProjectId: PROJECT }) } },
  PROJECT);
  return withPreferenceScope({ ...entry, context: { personal_space_id: SPACE, ...entry.context },
    checkpoint_required: false, checkpoint_guidance: STOP_HOOK_CHECKPOINT_GUIDANCE,
    resumed_checkpoint: false, previous_checkpoint_missing: false, task_guidance: taskKnowledgeGuidance(),
    conversation: { ...entry.conversation, revision: 3, recovered_from: null, compacted: false, guidance: CONVERSATION_GUIDANCE },
    agent_receipt: { ...entry.agent_receipt, guidance: RECEIPT_GUIDANCE },
    project_agent_context: syntheticContinuity(), project_management_context: management, judgment_context: judgment },
  { personal_space_id: SPACE, personal_project_id: PROJECT, project_agent_id: AGENT, session_id: sessionId,
    source_application: 'claude_code', preference_scope: { version: 1, work_kind: 'implementation', workflow: null } });
}

// The same working lead's get_collaboration_preferences when the client has no
// native host session (OpenCode code mode): the entry builder's preferences
// with no task begun, so no token, conversation or task rules, and the
// lifecycle the real entry finish adds.
export async function syntheticTokenlessEntry({ items }) {
  const { conversation: _conversation, taskContextToken: _token, task_context_token: _snake, checkpoint_required: _required,
    checkpoint_guidance: _checkpoint, resumed_checkpoint: _resumed, previous_checkpoint_missing: _missing,
    task_guidance: _task, ...preferences } = await syntheticWorkingEntry({ items, sessionId: null });
  return finishTaskEntryPreferences({}, preferences, { agentInvocation: true,
    agentToolName: 'get_collaboration_preferences', taskPrompt: 'fix the export bug' });
}

// An ordinary small coding task of the same working lead when nothing in the
// store matches it: both memory layers never written, the directory snapshot
// already current, a five-person team, Jefa's empty board, Tonborg's
// automatic judgment, a searched recall with no match, a saved conversation
// pointing at the last one, and no preferences. The entry's fixed cost.
export async function syntheticNoMatchEntry({ sessionId, token = 'fuli-task-6f1d2c3b-8a4e-4f5d-9b0c-1e2f3a4b5c6d' }) {
  const entry = await syntheticWorkingEntry({ items: [], sessionId, token });
  const continuity = syntheticContinuity();
  const empty = personalProjectId => agentMemoryView({ personal_space_id: SPACE, personal_project_id: personalProjectId,
    agent_id: AGENT, scope: personalProjectId === null ? 'private_agent_global' : 'private_agent_project',
    storage: 'provider', authority: 'working_context_not_confirmed_knowledge', revision: 0, current: null });
  const person = (index, occupation) => ({ agent_id: `project.member-${index}`, name: `Synthetic member ${index}`, occupation });
  return withPreferenceScope({ ...entry, active_conflicts: [], deferred_conflicts: [], conflicts: undefined,
    task_knowledge_recall: { status: 'no_match', partial: false, failed_query_count: 0,
      trigger_categories: ['release_delivery', 'requirements_architecture_decision'], query_count: 3,
      guidance: TASK_KNOWLEDGE_RETRIEVAL_GUIDANCE, sourceMarker: createFuliSourceMarker({}),
      noMatchSourceMarker: createFuliSourceMarker({}), facts: [], entities: [] },
    conversation: { status: 'saved', conversation_id: '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b01', revision: 0,
      recovery: null, recovered_from: null, compacted: false, recent_conversation: {
        id: '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b02', updated_at: '2026-10-26T10:00:00.000000+00:00',
        title: 'SYNTHETIC: closed by the Stop hook with no checkpoint.' }, guidance: CONVERSATION_GUIDANCE },
    project_management_context: { ...entry.project_management_context, managers: entry.project_management_context.managers
      .map(manager => ({ ...manager, board: { version: 0, total: 0, view: 'on_demand' } })) },
    project_agent_context: { ...continuity, selection_reason: 'project_team_lead', match_basis: [
      'project team lead is the stable conversation owner', '0 active team member(s) available for explicit workstreams',
      'AR and project manager remain peer roles'], role: { name: 'Synthetic lead',
      responsibility: 'SYNTHETIC lead who develops, fixes, tests and delivers the project.',
      initial_preferences: ['SYNTHETIC: read the existing code first.', 'SYNTHETIC: attach reproducible evidence.'] },
    project_brief: { name: 'project', summary: 'SYNTHETIC draft brief' },
    memory: empty(PROJECT), global_memory: empty(null),
    team: { ...continuity.team, roster: [{ agent_id: AGENT, name: 'Synthetic lead', occupation: null },
      person(1, 'engineering'), person(2, 'qa_automation'), person(3, 'engineering'), person(4, 'design')] },
    directorySnapshot: { ...continuity.directorySnapshot, files: [
      { file: 'AGENTS.md', scope: 'identity', state: 'unchanged' },
      { file: `projects/${PROJECT}/MEMORY.md`, scope: 'project', revision: 0, state: 'unchanged' },
      { file: 'MEMORY.md', scope: 'global', revision: 0, state: 'unchanged' }] },
    execution_reason: 'project_team_lead', execution_agent_id: AGENT } },
  { personal_space_id: SPACE, personal_project_id: PROJECT, project_agent_id: AGENT, session_id: sessionId,
    source_application: 'claude_code', preference_scope: { version: 1, work_kind: 'implementation', workflow: null } });
}

const NOTE = 'SYNTHETIC working note about the export cursor, the rollback plan and the review checklist for this project. ';

function memoryLayer(personalProjectId, revision) {
  const note = index => `${NOTE}${index}. ${NOTE}`.slice(0, 190);
  return agentMemoryView({ personal_space_id: SPACE, personal_project_id: personalProjectId, agent_id: AGENT,
    scope: personalProjectId === null ? 'private_agent_global' : 'private_agent_project', storage: 'provider',
    authority: 'agent_working_notes', revision,
    current: { checkpoint_id: `00000000-0000-4000-8000-0000000000${revision}${personalProjectId ? 1 : 2}`, personal_space_id: SPACE,
      personal_project_id: personalProjectId, agent_id: AGENT, revision, created_at: '2026-10-26T10:00:00.000Z',
      source_application: 'claude_code', source_session_id: '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6',
      task_id: `00000000-0000-4000-8000-00000000009${revision}`,
      memory: { summary: `SYNTHETIC summary. ${NOTE.repeat(4)}`, decisions: [1, 2, 3, 4].map(note),
        open_threads: [1, 2].map(note), next_actions: [1, 2].map(note) } },
    history: [], work_log: [] });
}

function syntheticContinuity() {
  const person = (index, occupation) => ({ agent_id: `project.member-${index}`, name: `Synthetic member ${index}`, occupation,
    responsibility: 'SYNTHETIC responsibility for one bounded part of the project.', role: 'member' });
  return { status: 'ready', project_agent_id: AGENT, personal_project_id: PROJECT, source_application: 'claude_code',
    wake_mode: 'task_entry', worker_started: false, selection_reason: 'project_lead', match_basis: [],
    role: { name: 'Synthetic lead', responsibility: 'SYNTHETIC lead who owns the export service and its review.',
      initial_preferences: [], character: { judgment: 'SYNTHETIC: weighs evidence before acting; asks when the scope is unclear.',
        taste: 'SYNTHETIC: small diffs, clear names.', personality: 'SYNTHETIC: calm and direct.' },
      expectations: 'SYNTHETIC: reports what was verified and what was not.' },
    project_brief: { name: 'Synthetic export service', summary: 'SYNTHETIC export service with paginated cursors.' },
    memory: memoryLayer(PROJECT, 7), global_memory: memoryLayer(null, 5),
    team: { lead_agent_id: AGENT, roster: [{ agent_id: AGENT, name: 'Synthetic lead', occupation: 'engineer', role: 'lead' },
      person(1, 'engineer'), person(2, 'tester'), person(3, 'designer')], user_facing_agent_id: AGENT,
    reporting_lines: [1, 2, 3].map(index => ({ agent_id: `project.member-${index}`, reports_to_agent_id: AGENT })),
    unavailable_agent_ids: [], assigned_collaborators: [], assigned_peers: [], peer_roles: ['hr', 'project_manager'],
    worker_started: false, guidance: TEAM_GUIDANCE },
    recent_tasks: [], knowledge: [], unavailable_components: [],
    directorySnapshot: { status: 'current', path: `/synthetic/fuli/agents/${SPACE}/${AGENT}`, files: [
      { file: 'AGENTS.md', scope: 'identity', state: 'unchanged' },
      { file: 'MEMORY.md', scope: 'global', revision: 5, state: 'unchanged' },
      { file: `projects/${PROJECT}.md`, scope: 'project', revision: 7, state: 'written' }] },
    guidance: PROJECT_AGENT_CONTINUITY_GUIDANCE };
}

// Jefa's task entry through the real employee entry with a synthetic board.
function syntheticManagement() {
  const manifest = { id: 'jefa', name: 'Jefa', role: 'Project manager', permissions: ['board.read', 'board.write'],
    taskEntry: { boardTool: 'read_board', titleTool: 'prepare_session_title' } };
  const context = { agentId: 'employee.jefa', name: 'Jefa', role: 'Project manager', project: { id: PROJECT },
    management: { mode: 'project', titleMode: 'suggest', titleStyle: 'concise' } };
  const board = { version: 12, total: 9, truncated: true, items: Array.from({ length: 9 }, (_, index) => ({
    id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`, title: `SYNTHETIC board item ${index + 1}`,
    status: 'todo', priority: 'medium', workType: 'feature', updatedAt: '2026-10-26T10:00:00.000Z' })) };
  return employeeTaskEntry({ app: { consoleUrl: 'http://127.0.0.1:4318', config: { personal: { spaceId: SPACE } } },
    registry: { catalog: () => [{ manifest, runtimeStatus: 'ready' }], get: () => ({ manifest }),
      runtime: async () => ({ describeTools: async () => [{ name: 'read_board', permission: 'board.read' }], callTool: async () => board }) },
    recruitment: { authorize: async () => context }, workspace: async () => context },
  { personalProjectId: PROJECT, sourceApplication: 'claude_code', sourceSessionId: '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6' });
}

export const hookFrame = text => JSON.parse(text.split('\n').at(-1));

// One synthetic Claude Code session through the real UserPromptSubmit entry
// and session delivery cache. `turn(entry)` delivers the entry (built with
// `session.sessionId`) and records what the host would: the whole context, or
// only a preview when it is longer than Claude Code keeps inline.
export async function claudeEntrySession(fn, { prompt = 'fix the export bug' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-claude-entry-'));
  try {
    const sessionId = randomUUID();
    const host = syntheticHost(directory, 'claude_code', sessionId);
    await host.start();
    const delivery = createSessionPreferenceDelivery({ directory: join(directory, 'cache'),
      locate: async () => ({ path: host.path, adapter: claudePreferenceEvidence }) });
    const input = { session_id: sessionId, transcript_path: host.path, cwd: directory, prompt };
    const turn = async entry => {
      const output = await claudeLifecycleOutput('UserPromptSubmit', input, async () => entry, { delivery });
      const text = output.hookSpecificOutput.additionalContext;
      await host.inject(text.length > CLAUDE_PREVIEW_CHARS ? `${text.slice(0, PREVIEW_HEAD_CHARS)}\n…[preview]` : text);
      return { text, frame: hookFrame(text) };
    };
    return await fn({ sessionId, host, delivery, turn });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
