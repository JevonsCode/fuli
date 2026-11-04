import assert from 'node:assert/strict';
import test from 'node:test';
import { updateRequested } from '../src/graphiti/task-update-request.js';

// rec#63: the model captured the new on-call channel beside the old one, so
// both stayed current; a prompt that says a kept fact changed now says to revise.
test('a prompt that says a kept fact changed is noticed', () => {
  for (const prompt of [
    'The ledger on-call channel moved: incidents now go to #ledger-oncall instead of the old channel.',
    'Correction: Orbit services now deploy to eu-central-1, not the region recorded earlier.',
    'Update what is remembered about this project accordingly.',
    '发布命令改成 --channel beta --sign 了。',
    '这个项目不再用 Docker 部署。'
  ]) assert.equal(updateRequested(prompt), true, prompt);
  for (const prompt of ['Fix the login page styles.', 'Add a retry to fetchRate and a test for it.', '修一下登录页的样式。'])
    assert.equal(updateRequested(prompt), false, prompt);
});

test('a change to something kept is never auto-closed and says to revise the item', async () => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../src/mcp/provider-task-context-registry.js');
  const application = { config: { personal: { spaceId: 'space' } }, taskContextRegistry: {
    begin: async () => taskRecord({ token: 'fuli-task-synthetic-3', session_id: 's', personal_project_id: null,
      routine_auto_close_eligible: true, entry_via: 'hook' }) } };
  const preferences = { context: { personal_project_id: null, project_agent_id: null }, effective_preferences: [] };
  const updating = await beginTaskFromPreferences(application, preferences,
    { sessionId: 's', taskPrompt: 'The deploy region changed to eu-central-1 instead of ap-southeast-1.' }, { entryVia: 'hook' });
  assert.equal(updating.checkpoint_required, true);
  assert.match(updating.update_guidance, /revise_personal_knowledge/);
  const ordinary = await beginTaskFromPreferences(application, preferences,
    { sessionId: 's', taskPrompt: '修一下登录页的样式。' }, { entryVia: 'hook' });
  assert.equal('update_guidance' in ordinary, false);
});
