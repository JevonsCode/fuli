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
  assert.deepEqual(view.task_guidance, { rules: `${ENTRY_RULES_URI}#task_guidance`, version });
  assert.equal(view.application_guidance.project_scope, 'Synthetic project scope.');
  assert.equal(view.application_guidance.inheritance, undefined);
  assert.equal(view.application_guidance.rules, `${ENTRY_RULES_URI}#application_guidance`);
  assert.equal(view.project_agent_context.team_guidance.rules, `${ENTRY_RULES_URI}#team_guidance`);
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
