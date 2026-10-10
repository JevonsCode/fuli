import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskEntryAgent } from '../src/graphiti/project-agent-task-entry.js';

// Synthetic directory. Provider resolution remains the authorization boundary.
const role = (id, name, status = 'active') => ({ agent_id: id,
  profile: { name, display_name: name, status, allowed_clients: ['cursor'] } });
function fixture(agents = [role('engineer', 'Alex Morgan')]) {
  const calls = [];
  const app = { config: { personal: { spaceId: 'space' } }, personal: {
    listProjectAgents: async (...args) => { calls.push(['directory', ...args]); return agents; },
    resolveProjectAgentContext: async input => {
      calls.push(['resolve', input]);
      return { status: 'ready', agent: agents.find(a => a.agent_id === input.agent_id) ?? role('default', 'Default') };
    }
  } };
  const run = (taskPrompt, extra = {}) => resolveTaskEntryAgent(app,
    { personalProjectId: 'sample' }, { agentInvocation: true,
      agentToolName: 'begin_task_context', sourceApplication: 'cursor', taskPrompt, ...extra });
  return { run, calls, app };
}
test('roundtable capability and receiving session reach Provider authorization', async () => {
  const { app, calls, run } = fixture();
  app.roundtable = { taskEntryDelegation(input) {
    assert.equal(input.sessionId, 'receiving-session');
    return { token: 'synthetic-capability-1234567890123456', sessionId: input.sessionId };
  } };
  await run('@{engineer} [FULI 圆桌 · synthetic-thread]\nReview this work', { receivingSessionId: 'receiving-session' });
  const request = calls.find(([name]) => name === 'resolve')[1];
  assert.equal(request.delegation_token, 'synthetic-capability-1234567890123456');
  assert.equal(request.delegation_session_id, 'receiving-session');
  assert.equal(request.report_to_agent_id, undefined);
});
test('leading @display name selects the exact current-project Agent before loading memory', async () => {
  const { run, calls } = fixture();
  const result = await run('@Alex Morgan 继续刚才的设计');
  assert.equal(result.agent.agentId, 'engineer');
  assert.deepEqual(calls[0].slice(0, 3), ['directory', 'space', 'sample']);
  assert.equal(calls[1][1].agent_id, 'engineer');
});
test('stable @{id} works even when the display name changes', async () => {
  const { run } = fixture([role('engineer', 'New Name')]);
  assert.equal((await run('@{engineer} continue')).agent.agentId, 'engineer');
});
test('portable mentions encode delimiters and keep identifier case exact', async () => {
  const id = 'Team / 编号}';
  const { run } = fixture([role(id, 'Alex'), role(id.toLowerCase(), 'Alex')]);
  assert.equal((await run(`@{${encodeURIComponent(id)}} continue`)).agent.agentId, id);
});
test('duplicate exact names require a choice and never select a default owner', async () => {
  const { run, calls } = fixture([role('a', 'Alex'), role('b', 'Alex')]);
  const result = await run('@Alex 继续');
  assert.equal(result.status, 'ambiguous_agent');
  assert.deepEqual(result.candidates.map(a => a.agent_id), ['a', 'b']);
  assert.equal(calls.some(c => c[0] === 'resolve'), false);
});
test('unknown or explicitly conflicting mention cannot fall back to another Agent', async () => {
  for (const [prompt, extra, status] of [['@Nobody continue', {}, 'agent_not_found'],
    ['@Alex Morgan continue', { projectAgentId: 'another' }, 'agent_selection_conflict']]) {
    const { run, calls } = fixture();
    assert.equal((await run(prompt, extra)).status, status);
    assert.equal(calls.some(c => c[0] === 'resolve'), false);
  }
});
test('quoted prose and non-leading mentions do not change the current owner or read the directory', async () => {
  const { run, calls } = fixture();
  await run('请解释 “@Alex Morgan” 的用法');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'resolve');
});
test('exact longest name wins over its prefix, with authorization still applied', async () => {
  const { run } = fixture([role('short', 'Alex'), role('long', 'Alex Morgan', 'inactive')]);
  const result = await run('@Alex Morgan continue');
  assert.equal(result.status, 'agent_unavailable');
  assert.equal(result.agent, undefined);
});
test('an older Provider cannot implicitly make the project manager the developer', async () => {
  const jefa = role('employee.jefa', 'Jefa');
  jefa.profile.work_kinds = ['project_management'];
  const { run } = fixture([jefa]);
  // The fixture behaves like an older Provider returning its sole employee.
  const app = { config: { personal: { spaceId: 'space' } }, personal: {
    resolveProjectAgentContext: async () => ({ status: 'ready', agent: jefa }),
    staffDefaultProjectLead: async () => ({ status: 'unassigned', reason: 'team_lead_unavailable' })
  } };
  const result = await resolveTaskEntryAgent(app, { personalProjectId: 'sample' }, {
    agentInvocation: true, agentToolName: 'begin_task_context', sourceApplication: 'cursor', taskPrompt: '优化功能实现'
  });
  assert.equal(result.status, 'unassigned');
  assert.equal(result.reason, 'specialist_required');
  assert.equal(result.agent, undefined);
  assert.equal((await run('@Jefa 整理看板')).agent.agentId, 'employee.jefa');
});

test('a project with nobody to own the task has HR staff its default lead', async () => {
  const lead = role('lead-1', 'Milo Reed');
  for (const resolved of [{ status: 'unassigned' }, { status: 'ready', agent: role('employee.jefa', 'Jefa') }]) {
    const staffed = [];
    const app = { config: { personal: { spaceId: 'space' } }, personal: {
      resolveProjectAgentContext: async () => resolved,
      staffDefaultProjectLead: async input => { staffed.push(input); return { status: 'ready', agent: lead }; }
    } };
    const result = await resolveTaskEntryAgent(app, { personalProjectId: 'sample' }, {
      agentInvocation: true, agentToolName: 'begin_task_context', sourceApplication: 'cursor', taskPrompt: '修复登录'
    });
    assert.equal(result.agent.agentId, 'lead-1');
    assert.deepEqual(staffed, [{ personal_space_id: 'space', personal_project_id: 'sample', source_application: 'cursor' }]);
  }
});

test('an explicitly selected Agent is never replaced by a default lead', async () => {
  let staffed = false;
  const app = { config: { personal: { spaceId: 'space' } }, personal: {
    resolveProjectAgentContext: async () => ({ status: 'agent_unavailable' }),
    staffDefaultProjectLead: async () => { staffed = true; return null; }
  } };
  const result = await resolveTaskEntryAgent(app, { personalProjectId: 'sample' }, {
    agentInvocation: true, agentToolName: 'begin_task_context', sourceApplication: 'cursor',
    taskPrompt: 'continue', projectAgentId: 'engineer'
  });
  assert.equal(staffed, false);
  assert.equal(result.agent, null);
});

test('a valid member request staffs a missing project lead then re-resolves the original request', async () => {
  let hasLead = false;
  const resolved = [];
  const app = { config: { personal: { spaceId: 'space' } }, personal: {
    resolveProjectAgentContext: async input => {
      resolved.push(input.agent_id);
      return hasLead ? { status: 'ready', agent: role('lead', 'Project Lead'), requested_agent_id: input.agent_id }
        : { status: 'unassigned', reason: 'project_lead_required' };
    },
    staffDefaultProjectLead: async () => { hasLead = true; return { status: 'ready', agent: role('lead', 'Project Lead') }; }
  } };
  const result = await resolveTaskEntryAgent(app, { personalProjectId: 'sample' }, {
    agentInvocation: true, agentToolName: 'begin_task_context', sourceApplication: 'cursor',
    projectAgentId: 'member', taskPrompt: 'continue'
  });
  assert.equal(result.agent.agentId, 'lead');
  assert.equal(result.requested_agent_id, 'member');
  assert.deepEqual(resolved, ['member', 'member']);
});
