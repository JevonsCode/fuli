import assert from 'node:assert/strict';
import test from 'node:test';
import { loadProjectTeamContext } from '../src/graphiti/project-agent-team-context.js';
import { providerProjectAgentCoordinationPolicy } from '../src/graphiti/project-agent-mapping.js';

test('team context contains scoped public roles, never another member memory', async () => {
  const app = { personal: {
    getProjectAgentCoordinationPolicy: async (space, project) => {
      assert.equal(space, 'space'); assert.equal(project, 'project');
      return { team_lead_agent_id: 'lead', team_member_agent_ids: ['member'] };
    },
    listProjectAgents: async () => ['lead', 'member', 'outside'].map(agent_id => ({
      agent_id, profile: { name: agent_id, responsibility: 'scoped work' }, memory: { private: 'never include' },
      assignments: [{ personal_project_id: 'project', status: 'active' }]
    }))
  } };
  const team = await loadProjectTeamContext(app, 'space', 'project');
  assert.deepEqual(team.roster.map(agent => agent.agent_id), ['lead', 'member']);
  assert.deepEqual(team.peer_roles, ['hr', 'project_manager']);
  assert.equal(team.worker_started, false);
  assert.ok(!JSON.stringify(team).includes('never include'));
});
test('team context reports unavailable members instead of restoring ended or other-project assignments', async () => {
  const team = await loadProjectTeamContext({ personal: {
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'lead', team_member_agent_ids: ['ended', 'other'] }),
    listProjectAgents: async () => [
      { agent_id: 'lead', assignments: [{ personal_project_id: 'project', status: 'active', responsibility: 'Lead this project' }] },
      { agent_id: 'ended', assignments: [{ personal_project_id: 'project', status: 'ended' }] },
      { agent_id: 'other', assignments: [{ personal_project_id: 'elsewhere', status: 'active' }] }
    ]
  } }, 'space', 'project');
  assert.deepEqual(team.roster.map(agent => [agent.agent_id, agent.responsibility]), [['lead', 'Lead this project']]);
  assert.deepEqual(team.unavailable_agent_ids, ['ended', 'other']);
});
test('team policy round-trips clearing, membership and concurrency revision without dropping omitted fields', () => {
  const input = { personalSpaceId: 'space', personalProjectId: 'project', askBeforeRecruitment: true, autoReusePreviousAgent: true };
  assert.ok(!Object.hasOwn(providerProjectAgentCoordinationPolicy(input), 'team_lead_agent_id'));
  assert.equal(providerProjectAgentCoordinationPolicy({ ...input, expectedUpdatedAt: null }).expected_updated_at, null);
  assert.deepEqual(providerProjectAgentCoordinationPolicy({ ...input, teamLeadAgentId: null, teamMemberAgentIds: [], expectedUpdatedAt: '2026-09-16T00:00:00Z' }), {
    personal_space_id: 'space', personal_project_id: 'project', ask_before_recruitment: true, auto_reuse_previous_agent: true,
    team_lead_agent_id: null, team_member_agent_ids: [], expected_updated_at: '2026-09-16T00:00:00Z'
  });
});
