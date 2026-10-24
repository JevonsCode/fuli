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
