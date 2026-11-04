import assert from 'node:assert/strict';
import test from 'node:test';
import { roundtableAskEntry } from '../src/graphiti/task-entry-roundtable-ask.js';

function application({ lead = 'saturn-lead', delegated = false } = {}) {
  return { config: { personal: { spaceId: 'space' } },
    roundtable: { taskEntryDelegation: () => delegated ? { token: 'synthetic-grant' } : null },
    personal: {
      getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: lead }),
      listPersonalProjects: async () => [
        { project_id: 'saturn', profile: { name: 'Saturn', lifecycle: 'active' } },
        { project_id: 'aicg', profile: { name: 'AICG', lifecycle: 'active' } },
        { project_id: 'aicg-web', profile: { name: 'AICG Web', lifecycle: 'active' } },
        { project_id: 'old', profile: { name: 'Legacy', lifecycle: 'archived' } }]
    } };
}
const ask = (taskPrompt, options, scope = { personalProjectId: 'saturn', agentId: 'saturn-lead' }) =>
  roundtableAskEntry(application(options), { taskPrompt, sessionId: 'session' }, scope);

test('"去看看 / 问问 X 项目" names that project and its roundtable address', async () => {
  for (const prompt of ['你去看看 AICG 项目是怎么做 UAT 绑定的', '问问aicg项目那个 key 怎么生效的',
    '去问一下 AICG 那边', 'Please ask the AICG project how the binding works']) {
    const hint = await ask(prompt);
    assert.deepEqual(hint?.projects, [{ projectId: 'aicg', name: 'AICG', address: 'project:aicg' }], prompt);
    assert.match(hint.guidance, /message_agent/);
  }
});

test('the longest name wins, so a longer project name is not read as a shorter one', async () => {
  const hint = await ask('看看 AICG Web 项目的登录页');
  assert.deepEqual(hint.projects.map(project => project.projectId), ['aicg-web']);
});

test('a project named in passing, the current or an archived project, gives no hint', async () => {
  for (const prompt of ['AICG 项目的 key 已经申请好了', '看看 Saturn 项目的测试', '问问 Legacy 项目', '看看 AICGX 项目', '修一下登录页'])
    assert.equal(await ask(prompt), null, prompt);
});

test('only the current project lead, in a session the person drives, gets the hint', async () => {
  assert.equal(await ask('问问 AICG 项目', { lead: 'someone-else' }), null);
  assert.equal(await ask('问问 AICG 项目', { delegated: true }), null);
  assert.equal(await ask('问问 AICG 项目', {}, { personalProjectId: null, agentId: 'saturn-lead' }), null);
});
