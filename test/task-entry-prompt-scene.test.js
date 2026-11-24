import assert from 'node:assert/strict';
import test from 'node:test';

import { beginTaskContext } from '../src/graphiti/agent-knowledge-workflows.js';
import { codexLifecycleOutput } from '../src/agents/codex/lifecycle-event.js';

// rec#85: Codex runs UserPromptSubmit again, with the same turn_id, for input
// that arrives while the turn runs (an async question's reply). Synthetic
// sessions and Provider doubles only.
const saved = { token: 'fuli-task-synthetic', sessionId: 'synthetic-session', turnId: 'turn-one',
  personalProjectId: 'synthetic-project', projectAgentId: null,
  preferenceScope: { version: 1, work_kind: 'implementation', workflow: null } };

function application() {
  const reads = [], writes = [];
  return { reads, writes, app: {
    taskContextRegistry: { current: async () => saved, context: async () => saved,
      begin: async input => { writes.push(input); return input.turnId === saved.turnId ? saved : { ...input, token: 'fuli-task-new' }; } },
    getCollaborationPreferences: async input => { reads.push(input); return { context: {
      personal_project_id: input.personalProjectId, project_agent_id: null } }; } } };
}
const entry = { sessionId: saved.sessionId, sourceApplication: 'codex', projectPath: '/synthetic/project' };

test('a prompt scene in a turn that already entered keeps the turn scene', async () => {
  const { app, reads } = application();
  const result = await beginTaskContext(app, { ...entry, turnId: 'turn-one', promptScene: 'test_validation',
    taskPrompt: '<send_user_message_question_reply>[{"answer":"先测试一下"}]</send_user_message_question_reply>' });
  assert.equal(result.taskContextToken, saved.token);
  assert.equal(reads[0].workKind, 'implementation');
});

test('a prompt scene scopes a new task, and an explicit different workKind is still refused', async () => {
  const { app, writes } = application();
  await beginTaskContext(app, { ...entry, turnId: 'turn-two', promptScene: 'test_validation' });
  assert.deepEqual(writes.at(-1).preferenceScope, { version: 1, work_kind: 'test_validation', workflow: null });
  await assert.rejects(beginTaskContext(app, { ...entry, turnId: 'turn-one', workKind: 'test_validation' }),
    error => error.status === 409);
});

test('the Codex hook sends the scene it reads from the prompt as a hint', async () => {
  const calls = [];
  await codexLifecycleOutput('UserPromptSubmit', { session_id: 'synthetic-session', turn_id: 'turn-one',
    cwd: '/synthetic/project', prompt: '先测试一下', transcript_path: null }, async (name, parameters) => {
    calls.push([name, parameters]);
    return { taskContextToken: 'fuli-task-synthetic' };
  });
  assert.equal(calls[0][0], 'begin_task_context');
  assert.equal(calls[0][1].promptScene, 'test_validation');
  assert.equal('workKind' in calls[0][1], false);
});
