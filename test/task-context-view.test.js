import assert from 'node:assert/strict';
import test from 'node:test';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { ENTRY_RULES_URI, entryRules, entryRulesMarkdown } from '../src/conversations/entry-rules.js';
import { beginConversation } from '../src/graphiti/agent-conversations.js';

// Synthetic entry with the real shared rule text, as the task entry builds it.
function entry(extra = {}) {
  const { sections } = entryRules();
  return { taskContextToken: 'fuli-task-synthetic',
    task_guidance: { ...sections.task_guidance },
    application_guidance: { apply: 'effective_preferences', project_scope: 'Synthetic project scope.',
      agent_scope: 'Synthetic agent scope.', ...sections.application_guidance },
    conversation: { status: 'saved', conversation_id: 'c-1', guidance: sections.conversation_guidance,
      recovery: { conversation_id: 'c-1', revision: 7, summary_role: 'historical',
        latest_checkpoint: { status: 'completed', summary: 'Last saved result.' },
        messages: [{ sequence: 1, role: 'user', content: 'Earlier prompt. '.repeat(100) }] } },
    project_agent_context: { guidance: sections.continuity_guidance, team: { guidance: sections.team_guidance },
      memory: { revision: 0, current: null, personalSpaceId: 's', personalProjectId: 'p', agentId: 'a' } },
    ...extra };
}

test('shared rule text becomes a versioned reference readable as one resource', () => {
  const view = compactTaskContext(entry());
  const { version, sections } = entryRules();
  assert.match(version, /^[0-9a-f]{12}$/);
  assert.deepEqual(view.task_guidance, { rules: `${ENTRY_RULES_URI}/task_guidance` });
  assert.equal(view.rules_version, version);
  assert.equal(view.application_guidance.project_scope, 'Synthetic project scope.');
  assert.equal(view.application_guidance.inheritance, undefined);
  assert.equal(view.application_guidance.rules, `${ENTRY_RULES_URI}/application_guidance`);
  assert.equal(view.project_agent_context.team_guidance.rules, `${ENTRY_RULES_URI}/team_guidance`);
  assert.equal(view.project_agent_context.memory.personalSpaceId, undefined);
  const markdown = entryRulesMarkdown();
  for (const text of [sections.task_guidance.checkpoint, sections.application_guidance.inheritance,
    sections.team_guidance, sections.conversation_guidance, sections.global_memory_guidance]) {
    assert.ok(markdown.includes(text));
  }
  assert.ok(JSON.stringify(view).length < JSON.stringify(entry()).length / 2);
});

test('changed rule text is never replaced by the shared reference', () => {
  const changed = entry();
  changed.task_guidance.collaboration = 'Worker-specific collaboration rule.';
  changed.application_guidance.inheritance = 'A different inheritance rule.';
  const view = compactTaskContext(changed);
  assert.equal(view.task_guidance.collaboration, 'Worker-specific collaboration rule.');
  assert.equal(view.application_guidance.inheritance, 'A different inheritance rule.');
});

// rec#15 PR2: a bound session no longer drops every recovered message here; what
// it has seen is decided per message at delivery (recent-context.test.js).
test('the entry view keeps the whole recovered window and its latest saved result', () => {
  const view = compactTaskContext(entry());
  assert.deepEqual(view.conversation.recovery.latest_checkpoint, { status: 'completed', summary: 'Last saved result.' });
  assert.equal(view.conversation.recovery.messages.length, 1);
  assert.equal(view.conversation.recovery.messages_omitted, undefined);
});

test('a sealed worker without resource access keeps full rule text and its messages', () => {
  const view = compactTaskContext(entry({ worker_run: { run_id: 'run-1' } }));
  assert.deepEqual(view.task_guidance, entryRules().sections.task_guidance);
  assert.equal(view.application_guidance.inheritance, entryRules().sections.application_guidance.inheritance);
  assert.equal(view.project_agent_context.team_guidance, entryRules().sections.team_guidance);
  assert.equal(view.project_agent_context.memory.guidance, entryRules().sections.memory_guidance);
  assert.equal(view.conversation.recovery.messages.length, 1);
});

test('a bound session recovers its conversation as itself; a new one gets only a pointer', async () => {
  const sessions = { 'native-a': 'c-1' };
  const queries = [];
  const application = { getCapturePolicy: () => ({ enabled: true }),
    config: { personal: { spaceId: 'space' } },
    // The Provider's begin: the bound conversation's window, or else the latest one of this scope.
    personal: { conversation: async (operation, input) => {
      queries.push({ operation, ...input });
      const previousId = sessions[input.session_id] ?? null;
      return { status: 'saved', conversation_id: previousId ?? 'c-2', recovered_from: previousId,
        previous: previousId ? { context: { messages: [] } } : null,
        recent: previousId ? null : { id: 'c-1', summary: 'Saved result', last_activity: 't1' } };
    } } };
  const task = { token: 't', projectAgentId: 'agent', personalProjectId: 'p', sourceApplication: 'codex' };
  const bound = await beginConversation(application, { ...task, sessionId: 'native-a' });
  assert.equal(bound.same_session, undefined);
  assert.equal(bound.recent_conversation, undefined);
  assert.deepEqual(bound.recovery, { messages: [] });
  assert.deepEqual(queries.map(query => [query.operation, query.session_id]), [['begin', 'native-a']]);
  queries.length = 0;
  const fresh = await beginConversation(application, { ...task, sessionId: 'native-b' });
  assert.deepEqual(fresh.recent_conversation, { id: 'c-1', updated_at: 't1', title: 'Saved result' });
  assert.equal(fresh.recovery, null);
  assert.deepEqual(queries.map(query => [query.operation, query.session_id]), [['begin', 'native-b']]);
});

// rec#11 D-84: every FLA's entry guidance carries the no-default-approval standard.
test('continuity guidance tells an FLA to act without default approvals and keep actions reversible', () => {
  const { continuity_guidance: guidance } = entryRules().sections;
  assert.match(guidance, /no approval step by default/);
  assert.match(guidance, /traceable and reversible instead of asking first/);
  assert.match(guidance, /confirm only what the person said they must confirm/);
  assert.match(guidance, /local-person-only actions to them/);
  assert.ok(entryRulesMarkdown().includes(guidance));
});

// rec#46: what an ordinary task's entry leaves out when nothing needs it. Synthetic entries only.
test('a no-match recall shows only noMatchSourceMarker; a match keeps both markers', () => {
  const marker = status => ({ required: true, label: 'FULI 来源', status, count: 0, leadMarkdown: `**[◇ FULI · ${status}](http://127.0.0.1:2727/)**`, markdown: '' });
  const recall = extra => ({ status: 'no_match', partial: false, failed_query_count: 0, trigger_categories: [], query_count: 3,
    sourceMarker: marker('no_match'), noMatchSourceMarker: marker('no_match'), facts: [], entities: [], ...extra });
  const none = compactTaskContext(entry({ task_knowledge_recall: recall() })).task_knowledge_recall;
  assert.deepEqual(none, { status: 'no_match', query_count: 3, noMatchSourceMarker: marker('no_match'), facts: [], entities: [] });
  const matched = compactTaskContext(entry({ task_knowledge_recall: recall({ status: 'matched', partial: true,
    failed_query_count: 1, trigger_categories: ['release_delivery'], sourceMarker: marker('matched') }) })).task_knowledge_recall;
  assert.deepEqual(matched.sourceMarker, marker('matched'));
  assert.deepEqual([matched.partial, matched.failed_query_count, matched.trigger_categories], [true, 1, ['release_delivery']]);
});

test('a never-written memory layer is its scope, revision 0 and rules; a written one keeps its preview', () => {
  const layer = current => ({ scope: 'private_agent_project', authority: 'working_context_not_confirmed_knowledge',
    revision: current ? 2 : 0, current, personalSpaceId: 's', personalProjectId: 'p', agentId: 'a' });
  const empty = compactTaskContext(entry({ project_agent_context: { memory: layer(null) } })).project_agent_context.memory;
  assert.deepEqual(empty, { scope: 'private_agent_project', revision: 0, current: null,
    guidance: { rules: `${ENTRY_RULES_URI}/memory_guidance` } });
  const written = compactTaskContext(entry({ project_agent_context: { memory: layer({ revision: 2,
    memory: { summary: 'SYNTHETIC summary', decisions: [], openThreads: [], nextActions: [] } }) } })).project_agent_context.memory;
  assert.equal(written.requiresFullReadBeforeWrite, true);
  assert.equal(written.current.memory.summary, 'SYNTHETIC summary');
});

test('an unchanged directory snapshot counts its files; a written file keeps the list', () => {
  const snapshot = state => ({ status: 'current', path: '/synthetic/agents/a', files: [
    { file: 'AGENTS.md', scope: 'identity', state: 'unchanged' }, { file: 'MEMORY.md', scope: 'global', revision: 0, state }] });
  const view = state => compactTaskContext(entry({ project_agent_context: { directorySnapshot: snapshot(state) } }))
    .project_agent_context.directorySnapshot;
  assert.deepEqual(view('unchanged'), { status: 'current', path: '/synthetic/agents/a', files_unchanged: 2 });
  assert.deepEqual(view('written'), snapshot('written'));
});

test('a self-executing lead drops its selection explanation; an unstaffed execution keeps it', () => {
  const continuity = extra => ({ project_agent_id: 'lead', selection_reason: 'project_team_lead',
    match_basis: ['project team lead is the stable conversation owner'], ...extra });
  const self = compactTaskContext(entry({ project_agent_context: continuity({ execution_reason: 'project_team_lead',
    execution_agent_id: 'lead' }) })).project_agent_context;
  assert.deepEqual([self.match_basis, self.execution_reason, self.execution_agent_id], [undefined, undefined, undefined]);
  assert.equal(self.selection_reason, 'project_team_lead');
  const gap = compactTaskContext(entry({ project_agent_context: continuity({ execution_reason: 'project_team_gap',
    execution_agent_id: null, match_basis: ['Execution is not staffed: use coordinate_project_agent_task.'] }) })).project_agent_context;
  assert.equal(gap.execution_reason, 'project_team_gap');
  assert.deepEqual(gap.match_basis, ['Execution is not staffed: use coordinate_project_agent_task.']);
});

test('a fresh conversation and task leave out their null and off fields; a resumed one keeps them', () => {
  const { sections } = entryRules();
  const fresh = compactTaskContext(entry({ resumed_checkpoint: false, previous_checkpoint_missing: false,
    conversation: { status: 'saved', conversation_id: 'c-2', revision: 0, recovery: null, recovered_from: null,
      compacted: false, guidance: sections.conversation_guidance } }));
  assert.deepEqual(fresh.conversation, { status: 'saved', conversation_id: 'c-2', revision: 0,
    guidance: { rules: `${ENTRY_RULES_URI}/conversation_guidance` } });
  assert.equal(Object.hasOwn(fresh, 'resumed_checkpoint'), false);
  assert.equal(Object.hasOwn(fresh, 'previous_checkpoint_missing'), false);
  const resumed = compactTaskContext(entry({ resumed_checkpoint: true, previous_checkpoint_missing: true }));
  assert.deepEqual([resumed.resumed_checkpoint, resumed.previous_checkpoint_missing], [true, true]);
  assert.equal(resumed.conversation.recovery.revision, 7);
});

test('an entry states the shared rules version once; a sealed worker keeps full rule text', () => {
  const view = compactTaskContext(entry());
  const versions = JSON.stringify(view).match(/"version":/g) ?? [];
  assert.equal(view.rules_version, entryRules().version);
  assert.equal(versions.length, 0);
  const worker = compactTaskContext(entry({ worker_run: true }));
  assert.equal(worker.rules_version, undefined);
  assert.equal(worker.task_guidance.checkpoint, entryRules().sections.task_guidance.checkpoint);
});
