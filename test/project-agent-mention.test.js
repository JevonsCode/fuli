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
  await run('#FLA {engineer} [FULI 圆桌 · synthetic-thread]\nReview this work', { receivingSessionId: 'receiving-session' });
  const request = calls.find(([name]) => name === 'resolve')[1];
  assert.equal(request.delegation_token, 'synthetic-capability-1234567890123456');
  assert.equal(request.delegation_session_id, 'receiving-session');
  assert.equal(request.report_to_agent_id, undefined);
});
test('stable #FLA {id} selects that current-project Agent before loading memory, whatever its name', async () => {
  const { run, calls } = fixture([role('engineer', 'New Name')]);
  const result = await run('#FLA {engineer} continue');
  assert.equal(result.agent.agentId, 'engineer');
  assert.deepEqual(calls[0].slice(0, 3), ['directory', 'space', 'sample']);
  assert.equal(calls[1][1].agent_id, 'engineer');
});
test('portable mentions encode delimiters and keep identifier case exact', async () => {
  const id = 'Team / 编号}';
  const { run } = fixture([role(id, 'Alex'), role(id.toLowerCase(), 'Alex')]);
  assert.equal((await run(`#FLA {${encodeURIComponent(id)}} continue`)).agent.agentId, id);
});
test('a legacy @{uuid} from an older prompt still selects its Agent; other @{id} forms do not', async () => {
  const uuid = '3c0a8f5e-1b2d-4e6f-9a7b-8c9d0e1f2a3b';
  const { run } = fixture([role(uuid, 'Alex Morgan'), role('engineer', 'Sam Lee')]);
  assert.equal((await run(`@{${uuid}} continue`)).agent.agentId, uuid);
  const { run: plain, calls } = fixture();
  assert.equal((await plain('@{engineer} continue')).agent.agentId, 'default');
  assert.equal(calls[0][1].agent_id, null);
});
test('an unknown or explicitly conflicting stable ID cannot fall back to another Agent', async () => {
  for (const [prompt, extra, status] of [['#FLA {nobody} continue', {}, 'agent_not_found'],
    ['#FLA {engineer} continue', { projectAgentId: 'another' }, 'agent_selection_conflict']]) {
    const { run, calls } = fixture();
    assert.equal((await run(prompt, extra)).status, status);
    assert.equal(calls.some(c => c[0] === 'resolve'), false);
  }
});
test('@ addresses nobody: names, attached files and quoted prose keep the normal owner without reading the directory', async () => {
  for (const prompt of ['@Alex Morgan 继续刚才的设计', '@Nobody continue', '@engineer continue',
    '@"C:\\Users\\sample\\Videos\\Recordings\\20261108-0130-26.0676773.mp4" 帮我看看',
    '@C:\\Users\\示例\\Desktop\\a b.txt 总结', '@/home/sample/录屏 1.mov 看下', '@~/clip.mp4 剪一下',
    '@报告-终稿.pdf 总结', '请解释 “#FLA {engineer}” 的用法']) {
    const { run, calls } = fixture();
    const result = await run(prompt);
    assert.equal(result.status, 'ready', prompt);
    assert.equal(result.agent.agentId, 'default', prompt);
    assert.deepEqual(calls.map(([name]) => name), ['resolve'], prompt);
    assert.equal(calls[0][1].agent_id, null, prompt);
  }
});
test('a stable ID still goes through authorization', async () => {
  const { run } = fixture([role('long', 'Alex Morgan', 'inactive')]);
  const result = await run('#FLA {long} continue');
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
  assert.equal((await run('#FLA {employee.jefa} 整理看板')).agent.agentId, 'employee.jefa');
});

test('a project with nobody to own the task has AR staff its default lead', async () => {
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

test('lead conversation ownership keeps the unstaffed execution decision visible', async () => {
  let staffed = false;
  const app = { config: { personal: { spaceId: 'space' } }, personal: {
    resolveProjectAgentContext: async () => ({
      status: 'ready', reason: 'project_team_lead', agent: role('lead', 'Synthetic Lead'),
      execution_reason: 'project_team_gap', execution_agent_id: null,
      match_basis: ['Execution is not staffed: use coordinate_project_agent_task to open HR recruitment.']
    }),
    staffDefaultProjectLead: async () => { staffed = true; return null; }
  } };
  const result = await resolveTaskEntryAgent(app, { personalProjectId: 'sample' }, {
    agentInvocation: true, agentToolName: 'begin_task_context', sourceApplication: 'cursor',
    taskPrompt: 'verify the export'
  });
  assert.equal(result.agent.agentId, 'lead');
  assert.equal(result.execution_reason, 'project_team_gap');
  assert.equal(result.execution_agent_id, null);
  assert.equal(result.worker_started, false);
  assert.equal(staffed, false);
  assert.ok(result.match_basis.some(item => item.includes('coordinate_project_agent_task')));
});

test('a built-in role outside its project scope says so; a client refusal is checked first and keeps its own reason', async () => {
  const bole = role('employee.bole', 'Bole');
  const calls = [];
  for (const [clients, refusal, reason] of [[['cursor'], 'assignment_required', 'not_responsible'],
    [['codex'], 'assignment_required', 'client_not_allowed'], [['cursor'], 'project_not_found', undefined]]) {
    const { run, app } = fixture([{ ...bole, profile: { ...bole.profile, allowed_clients: clients } }]);
    app.employees = { authorize: async input => {
      calls.push(input);
      throw Object.assign(new Error('Synthetic refusal'), { status: 403, code: refusal });
    } };
    const result = await run('#FLA {employee.bole} 看下人员分布');
    assert.equal(result.status, 'agent_unavailable');
    assert.equal(result.reason, reason);
    assert.equal(result.agent, undefined);
  }
  // Only the two Cursor runs reached the scope check, with this project.
  assert.deepEqual(calls.map(input => [input.templateId, input.personalProjectId]), [['bole', 'sample'], ['bole', 'sample']]);
});
