import assert from 'node:assert/strict';
import test from 'node:test';

import { preferenceHookOutput } from '../src/conversations/preference-lifecycle.js';
import { beginTaskEntry, finishTaskEntryPreferences } from '../src/graphiti/task-entry-preferences.js';

const SPACE = 'space-synthetic';
const refusal = () => Object.assign(new Error('The graph cannot be written now.'), { code: 'data_format_read_only' });
const preference = { id: 'p1', instruction: 'Synthetic preference', item_kind: 'entity', preference_key: 'synthetic', preference_scope: 'global', confirmation_status: 'confirmed' };

function application({ failure = refusal() } = {}) {
  return { config: { personal: { spaceId: SPACE } }, taskContextRegistry: {},
    projectPathResolver: () => ({ personalProjectId: 'project-synthetic', status: 'matched' }),
    getCollaborationPreferences: async () => { throw failure; },
    listPersonalProjects: async () => [],
    personal: { listPersonalProjects: async () => [],
      collaborationPreferences: async () => ({ effective_preferences: [preference], global_preferences: [preference], project_preferences: [], agent_preferences: [], conflicts: [] }) } };
}

test('a graph waiting for the person keeps the preferences, records nothing and says why', async () => {
  const entry = await beginTaskEntry(application(), { sessionId: 's1', projectPath: '/synthetic', sourceApplication: 'codex' });
  assert.equal(entry.taskContextToken, undefined);
  assert.equal(entry.checkpoint_required, false);
  assert.equal(entry.task_lifecycle.reason, 'data_format_read_only');
  assert.match(entry.task_lifecycle.guidance, /数据格式/);
  assert.equal(entry.context.personal_project_id, 'project-synthetic');
  assert.deepEqual(entry.effective_preferences.map(item => item.id), ['p1']);
});

test('any other failure of the entry stays a failure', async () => {
  const failure = Object.assign(new Error('down'), { code: 'provider_unavailable' });
  await assert.rejects(beginTaskEntry(application({ failure }), { sessionId: 's1', projectPath: '/synthetic' }), /down/);
});

test('an Agent asking for preferences gets them when the task cannot be written', async () => {
  const app = application();
  app.taskContextRegistry = { begin: async () => { throw refusal(); } };
  const answer = await finishTaskEntryPreferences(app, { effective_preferences: [preference], context: { personal_project_id: 'project-synthetic' } },
    { agentInvocation: true, agentToolName: 'get_collaboration_preferences', sessionId: 's1', taskPrompt: 'synthetic task' });
  assert.equal(answer.task_lifecycle.reason, 'data_format_read_only');
  assert.equal(answer.effective_preferences.length, 1);
});

test('a hook shows an entry without a task, and delivery is not asked to track it', async () => {
  const entry = await beginTaskEntry(application(), { sessionId: 's1', projectPath: '/synthetic' });
  const delivery = { deliver: async () => assert.fail('nothing to track') };
  const output = await preferenceHookOutput(entry, 'UserPromptSubmit', { session_id: 's1', prompt: 'p' }, delivery, 'codex', 'Fuli task context.');
  assert.match(output.hookSpecificOutput.additionalContext, /Synthetic preference/);
  assert.match(output.hookSpecificOutput.additionalContext, /data_format_read_only/);
});
