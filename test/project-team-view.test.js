import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProjectTeam, loadProjectTeam } from '../src/graphiti/project-team-view.js';
import { loadProjectTeamContext } from '../src/graphiti/project-agent-team-context.js';

const assigned = (agent_id, extra = {}) => ({
  agent_id, employee_number: extra.number ?? null,
  profile: { name: agent_id, responsibility: `${agent_id} profile`, status: extra.status ?? 'active',
    capabilities: extra.capabilities ?? [], ...(extra.agentType ? { agent_type: extra.agentType } : {}) },
  memory: { private: 'never include' },
  assignments: extra.assignments ?? [{ personal_project_id: 'project', status: 'active',
    responsibility: `${agent_id} on project` }]
});

test('project team keeps one lead, explicit members, other assignments as collaborators and peers as peers', () => {
  const team = buildProjectTeam({ projectId: 'project',
    policy: { team_lead_agent_id: 'lead', team_member_agent_ids: ['member', 'lead', 'member'] },
    agents: [assigned('lead', { number: '000123' }), assigned('member'), assigned('helper'),
      assigned('employee.bole'), assigned('reviewer', { agentType: 'hr' })] });
  assert.equal(team.status, 'ready');
  assert.deepEqual(team.lead, { agentId: 'lead', name: 'lead', employeeNumber: '000123', occupationEmoji: null,
    responsibility: 'lead on project', peerRole: false });
  assert.deepEqual(team.members.map(member => [member.agentId, member.reportsToAgentId]), [['member', 'lead']]);
  assert.deepEqual(team.collaborators.map(person => person.agentId), ['helper']);
  assert.deepEqual(team.peers.map(person => person.agentId), ['employee.bole', 'reviewer']);
  assert.ok(!JSON.stringify(team).includes('never include'));
});

test('a peer role named in a legacy member list stays a peer without a reporting line', () => {
  const team = buildProjectTeam({ projectId: 'project',
    policy: { team_lead_agent_id: 'lead', team_member_agent_ids: ['employee.jefa', 'member'] },
    agents: [assigned('lead'), assigned('member'), assigned('employee.jefa')] });
  assert.deepEqual(team.members.map(member => member.agentId), ['member']);
  assert.deepEqual(team.peers.map(person => [person.agentId, person.reportsToAgentId]), [['employee.jefa', undefined]]);
});

test('project team excludes ended, archived and other-project assignments and reports them', () => {
  const team = buildProjectTeam({ projectId: 'project',
    policy: { team_lead_agent_id: 'lead', team_member_agent_ids: ['ended', 'archived', 'elsewhere'] },
    agents: [assigned('lead'),
      assigned('ended', { assignments: [{ personal_project_id: 'project', status: 'ended' }] }),
      assigned('archived', { status: 'archived' }),
      assigned('elsewhere', { assignments: [{ personal_project_id: 'child-project', status: 'active' }] }),
      assigned('parent-only', { assignments: [{ personal_project_id: 'parent-project', status: 'active' }] })] });
  assert.deepEqual(team.members, []);
  assert.deepEqual(team.collaborators, []);
  assert.deepEqual(team.unavailableMemberIds, ['ended', 'archived', 'elsewhere']);
});

test('project team reports a missing or unavailable lead instead of promoting someone else', () => {
  const none = buildProjectTeam({ projectId: 'project', policy: { team_lead_agent_id: null,
    team_member_agent_ids: [] }, agents: [assigned('helper')] });
  assert.equal(none.status, 'no_lead');
  assert.equal(none.lead, null);
  assert.deepEqual(none.collaborators.map(person => person.agentId), ['helper']);

  const gone = buildProjectTeam({ projectId: 'project', policy: { team_lead_agent_id: 'lead',
    team_member_agent_ids: ['member'] }, agents: [
    assigned('lead', { assignments: [{ personal_project_id: 'project', status: 'ended' }] }), assigned('member')] });
  assert.equal(gone.status, 'lead_unavailable');
  assert.equal(gone.lead, null);
  assert.deepEqual(gone.unavailableLead, { agentId: 'lead', name: 'lead' });
  assert.deepEqual(gone.members.map(member => [member.agentId, member.reportsToAgentId]), [['member', null]]);
});

test('project team reads the exact project only', async () => {
  const calls = [];
  const team = await loadProjectTeam({ personal: {
    getProjectAgentCoordinationPolicy: async (...args) => { calls.push(['policy', ...args]);
      return { team_lead_agent_id: 'lead', team_member_agent_ids: [] }; },
    listProjectAgents: async (...args) => { calls.push(['agents', ...args]); return { agents: [assigned('lead')] }; }
  } }, 'space', 'project');
  assert.equal(team.lead.agentId, 'lead');
  assert.deepEqual(calls, [['policy', 'space', 'project'], ['agents', 'space', 'project', { status: 'active' }]]);
});

test('task-entry team context lists assigned collaborators without making them direct reports', async () => {
  const context = await loadProjectTeamContext({ personal: {
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'lead', team_member_agent_ids: ['member'] }),
    listProjectAgents: async () => [assigned('lead'), assigned('member'), assigned('helper'), assigned('employee.jefa')]
  } }, 'space', 'project');
  assert.deepEqual(context.reporting_lines, [{ agent_id: 'member', reports_to_agent_id: 'lead' }]);
  assert.deepEqual(context.assigned_collaborators.map(person => [person.agent_id, person.role]), [['helper', 'collaborator']]);
  assert.deepEqual(context.assigned_peers.map(person => person.agent_id), ['employee.jefa']);
  assert.equal(await loadProjectTeamContext({ personal: {
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: null }),
    listProjectAgents: async () => [assigned('helper')]
  } }, 'space', 'project'), null);
});
