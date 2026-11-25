import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callAgentTool } from '../../src/agent-tools.js';
import { createAgentWorkflows } from '../../src/agent-workflows/port.js';
import { loadProjectTeam } from '../../src/graphiti/project-team-view.js';
import { createStandingAssignments } from '../../src/standing-assignments/port.js';
import {
  createProjectAgentAssignment,
  updateProjectAgentCoordinationPolicy,
  upsertProjectAgent
} from '../../src/graphiti/project-agent-workflows.js';
import { createTeamTemplateReceipts, withImportedTeamTemplate } from '../../src/team-templates/receipts.js';
import {
  exportProjectTeamTemplateTool,
  importProjectTeamTemplateTool,
  previewProjectTeamTemplateImportTool,
  readProjectTeamTemplateTool
} from '../../src/team-templates/agent-tools.js';

// Shared fixtures for the portable project team template tests: a real Agent
// tool entry, the real team reading, and the real workflow and
// standing-assignment stores against an in-memory Provider double. No real
// FULI data is read.

export const SPACE = 'space-a';
export const SOURCE = 'project-a';
export const TARGET = 'project-b';
export const BOOTSTRAP_REASON = 'Every task needs a FULI Agent; this project had no team lead.';
export const BOOTSTRAP_RESPONSIBILITY = '统筹 Synthetic target 的任务拆分、分工、集成与交付，延续项目上下文';

// The trusted task contexts a call resolves through callingTask. A real task
// entry binds a token to one project; the stand-in registry does the same, so
// the tests exercise the same scope check the Provider-backed registry does.
const TASK_TOKENS = new Map();
export function taskTokenFor(projectId) {
  const token = `fuli-task-${projectId}`;
  TASK_TOKENS.set(token, { sessionId: `session-${projectId}`, personalProjectId: projectId,
    projectAgentId: null, sourceApplication: 'other' });
  return token;
}

// Every call carries a token bound to the project it names, as a real task
// entry does. A test that checks the refusal passes another project's token.
export function callTeamTool(app, name, input, taskContextToken = taskTokenFor(input.personalProjectId)) {
  return callAgentTool(app, name, { ...input, taskContextToken });
}

function notFound(what) {
  return Object.assign(new Error(`No ${what} has this ID.`), { status: 404 });
}

export function fakeProvider({ projects = [], agents = [], experiences = [] } = {}) {
  const state = {
    projects: new Map(projects.map(project => [project.projectId, project])),
    agents: new Map(agents.map(agent => [agent.agent_id, agent])),
    policies: new Map(),
    assignments: new Map(),
    experiences: [...experiences],
    tick: 0
  };
  const now = () => new Date(Date.UTC(2026, 10, 25, 0, 0, state.tick++)).toISOString();
  const policyOf = projectId => state.policies.get(projectId) ?? {
    personal_space_id: SPACE,
    personal_project_id: projectId,
    ask_before_recruitment: false,
    auto_reuse_previous_agent: true,
    auto_grow_team: true,
    team_lead_agent_id: null,
    team_member_agent_ids: [],
    sub_teams: [],
    sub_team_suggestion_threshold: 6,
    updated_at: '2026-01-01T00:00:00.000Z'
  };
  return {
    state,
    async getPersonalProject(_spaceId, personalProjectId) {
      const project = state.projects.get(personalProjectId);
      if (!project) throw notFound('project');
      return project;
    },
    async getProjectAgentCoordinationPolicy(_spaceId, personalProjectId) {
      return policyOf(personalProjectId);
    },
    async listProjectAgents(_spaceId, personalProjectId) {
      return [...state.agents.values()].filter(agent => agent.personal_project_id === personalProjectId
        || (agent.assignments ?? []).some(assignment => assignment.personal_project_id === personalProjectId
          && assignment.status === 'active'));
    },
    async getProjectAgent(_spaceId, _personalProjectId, agentId) {
      const agent = state.agents.get(agentId);
      if (!agent) throw notFound('Agent');
      return agent;
    },
    // The kept acceptance checks a source project's graph holds, as the
    // acceptance port reads them: only a confirmed experience with a check.
    async graph(_spaceId, _limit, personalProjectId = null) {
      const nodes = state.experiences
        .filter(item => (item.projectId ?? null) === (personalProjectId ?? null))
        .map(item => ({
          id: item.id,
          name: item.text,
          type: 'ReusableExperience',
          version_status: 'current',
          invalid_at: null,
          confirmation_status: 'confirmed',
          attributes: { solution: item.text, check: { kind: item.kind ?? 'acceptance_item', text: item.text } },
          confirmation_basis: { proposed_by: { label: item.agentId },
            confirmed_at: '2026-01-02T00:00:00.000Z' }
        }));
      return { nodes, edges: [], truncated: false, next_offset: null };
    },
    async upsertProjectAgent(input) {
      const previous = state.agents.get(input.agent_id);
      const agent = {
        agent_id: input.agent_id,
        personal_space_id: input.personal_space_id,
        personal_project_id: input.personal_project_id ?? previous?.personal_project_id ?? null,
        profile: {
          ...(previous?.profile ?? {}),
          ...input.profile,
          initial_preferences: input.profile.initial_preferences ?? previous?.profile?.initial_preferences ?? []
        },
        occupation: input.occupation ?? previous?.occupation ?? null,
        assignments: previous?.assignments ?? [],
        created_at: previous?.created_at ?? now(),
        updated_at: now()
      };
      state.agents.set(agent.agent_id, agent);
      return agent;
    },
    async createProjectAgentAssignment(input) {
      const existing = state.assignments.get(input.idempotency_key);
      if (existing) return existing;
      const agent = state.agents.get(input.agent_id);
      if (!agent) throw notFound('Agent');
      const assignment = {
        assignment_id: `assignment-${state.assignments.size + 1}`,
        personal_space_id: input.personal_space_id,
        personal_project_id: input.personal_project_id,
        agent_id: input.agent_id,
        idempotency_key: input.idempotency_key,
        responsibility: input.responsibility,
        work_kinds: input.work_kinds ?? [],
        capabilities: input.capabilities ?? [],
        reason: input.reason,
        status: 'active',
        revision: 1,
        source_application: input.source_application ?? null,
        source_session_id: input.source_session_id ?? null,
        assigned_at: now(),
        updated_at: now()
      };
      state.assignments.set(input.idempotency_key, assignment);
      agent.assignments = [...(agent.assignments ?? []), assignment];
      return assignment;
    },
    async updateProjectAgentCoordinationPolicy(input) {
      const current = policyOf(input.personal_project_id);
      if (input.expected_updated_at != null && current.updated_at !== input.expected_updated_at) {
        throw Object.assign(new Error('The policy changed since it was read.'), { code: 'policy_changed', status: 409 });
      }
      const next = {
        ...current,
        ...(input.ask_before_recruitment == null ? {} : { ask_before_recruitment: input.ask_before_recruitment }),
        auto_reuse_previous_agent: input.auto_reuse_previous_agent ?? current.auto_reuse_previous_agent,
        ...(input.auto_grow_team === undefined ? {} : { auto_grow_team: input.auto_grow_team }),
        ...(input.team_lead_agent_id === undefined ? {} : { team_lead_agent_id: input.team_lead_agent_id }),
        ...(input.team_member_agent_ids === undefined ? {} : { team_member_agent_ids: input.team_member_agent_ids }),
        ...(input.sub_teams === undefined ? {} : { sub_teams: input.sub_teams }),
        ...(input.sub_team_suggestion_threshold === undefined
          ? {} : { sub_team_suggestion_threshold: input.sub_team_suggestion_threshold }),
        updated_at: now()
      };
      state.policies.set(input.personal_project_id, next);
      return next;
    }
  };
}

// The composition root the Agent tools see: the Provider port plus the real
// project-Agent workflows and the local stores.
export function appFor(provider, { workflows, assignments, refs = null, receipts = null }) {
  return {
    config: { personal: { spaceId: SPACE } },
    personal: provider,
    agentWorkflows: workflows,
    standingAssignments: assignments,
    teamTemplateRefs: refs,
    teamTemplateReceipts: receipts,
    taskContextRegistry: { context: async token => TASK_TOKENS.get(token) ?? null },
    async listProjectAgents(input) {
      const agents = await provider.listProjectAgents(input.personalSpaceId, input.personalProjectId ?? null);
      return agents.map(agent => ({ agentId: agent.agent_id, occupation: agent.occupation,
        assignments: agent.assignments }));
    },
    async upsertProjectAgent(input) { return upsertProjectAgent(this, input); },
    async createProjectAgentAssignment(input) { return createProjectAgentAssignment(this, input); },
    async updateProjectAgentCoordinationPolicy(input) {
      return updateProjectAgentCoordinationPolicy(this, input);
    },
    async getProjectTeam(input) {
      const team = await loadProjectTeam(this, input.personalSpaceId, input.personalProjectId,
        { withProgress: input.withProgress === true });
      // The normal team read names a draft an import left, the same way the
      // application does, so a new session finds it without a new tool.
      return withImportedTeamTemplate(team,
        receipts?.read?.(input.personalSpaceId, input.personalProjectId) ?? null);
    },
    async exportProjectTeamTemplate(input) { return exportProjectTeamTemplateTool(this, input); },
    async previewProjectTeamTemplateImport(input) { return previewProjectTeamTemplateImportTool(this, input); },
    async importProjectTeamTemplate(input) { return importProjectTeamTemplateTool(this, input); },
    async readProjectTeamTemplate(input) { return readProjectTeamTemplateTool(this, input); }
  };
}

function receiptsDirectoryFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-team-receipts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function world(t, { projects, agents = [], experiences = [], refs = null, receiptsDirectory = null }) {
  const provider = fakeProvider({ projects, agents, experiences });
  const workflows = createAgentWorkflows();
  const assignments = createStandingAssignments();
  const directory = receiptsDirectory ?? receiptsDirectoryFor(t);
  const receipts = createTeamTemplateReceipts({ directory });
  t.after(() => { workflows.close(); assignments.close(); });
  return { provider, workflows, assignments, receipts, receiptsDirectory: directory,
    app: appFor(provider, { workflows, assignments, refs, receipts }) };
}

export function agent({ id, occupation, responsibility, assignments = [], agentType = 'durable', capabilities = [] }) {
  return {
    agent_id: id,
    personal_space_id: SPACE,
    personal_project_id: null,
    profile: {
      name: occupation,
      responsibility,
      capabilities,
      initial_preferences: [],
      status: 'active',
      agent_type: agentType
    },
    occupation: { role: occupation, tags: [] },
    assignments
  };
}

export function assignment({ projectId, agentId, responsibility }) {
  return {
    assignment_id: `source-${agentId}`,
    personal_space_id: SPACE,
    personal_project_id: projectId,
    agent_id: agentId,
    responsibility,
    work_kinds: [],
    capabilities: [],
    status: 'active',
    revision: 1
  };
}

// A source team with a lead, two specialists, one confirmed workflow and one
// recurring line of work. `learned` adds a confirmed lesson; `inactive` adds a
// proposed workflow and a recurring line for someone outside the team;
// `checks` adds the project's own kept acceptance check.
export function sourceWorld(t, { learned = false, inactive = false, checks = false } = {}) {
  const worldIn = world(t, {
    projects: [{ projectId: SOURCE, profile: { name: 'Synthetic source' } }],
    agents: [
      agent({ id: 'lead-1', occupation: 'planner', responsibility: 'Plan the synthetic work',
        assignments: [assignment({ projectId: SOURCE, agentId: 'lead-1', responsibility: 'Plan the synthetic work' })] }),
      agent({ id: 'member-1', occupation: 'builder', responsibility: 'Build the synthetic thing',
        assignments: [assignment({ projectId: SOURCE, agentId: 'member-1', responsibility: 'Build the synthetic thing' })] }),
      agent({ id: 'member-2', occupation: 'reviewer', responsibility: 'Review the synthetic thing',
        assignments: [assignment({ projectId: SOURCE, agentId: 'member-2', responsibility: 'Review the synthetic thing' })] }),
      agent({ id: 'outsider-1', occupation: 'archivist', responsibility: 'Keep an unrelated archive',
        assignments: [assignment({ projectId: SOURCE, agentId: 'outsider-1', responsibility: 'Keep an unrelated archive' })] })
    ],
    experiences: checks ? [{
      id: 'check-1', projectId: SOURCE, agentId: 'member-1', kind: 'acceptance_item',
      text: 'The synthetic build passes its release check'
    }] : []
  });
  worldIn.provider.state.policies.set(SOURCE, {
    personal_space_id: SPACE, personal_project_id: SOURCE,
    ask_before_recruitment: true, auto_reuse_previous_agent: false, auto_grow_team: false,
    team_lead_agent_id: 'lead-1', team_member_agent_ids: ['member-1', 'member-2'], sub_teams: [],
    sub_team_suggestion_threshold: 9, updated_at: '2026-02-01T00:00:00.000Z'
  });

  const owner = { personalSpaceId: SPACE, agentId: 'member-1', personalProjectId: SOURCE };
  const proposal = worldIn.workflows.propose(owner, {
    name: 'Synthetic release check',
    purpose: 'Check a synthetic build before release',
    steps: [{ title: 'Run the synthetic tests' }, { title: 'Write the synthetic report', detail: 'One page.' }],
    source: 'agent'
  });
  worldIn.workflows.decide({ personalSpaceId: SPACE, workflowId: proposal.workflow.workflowId,
    decision: 'confirm', version: 1 });
  worldIn.assignments.register({ personalSpaceId: SPACE, projectId: SOURCE, leadAgentId: 'member-1',
    terms: ['synthetic release'], responsibility: 'Cut a synthetic release', preferenceIds: [], source: 'host',
    sourceConversationId: null });

  if (learned) {
    worldIn.workflows.propose({ personalSpaceId: SPACE, agentId: 'member-2', personalProjectId: SOURCE }, {
      name: 'Synthetic review lesson',
      purpose: 'Review a synthetic release without the source task',
      steps: [{ title: 'Read the synthetic diff' }, { title: 'Report the synthetic risk' }],
      source: 'lesson',
      approval: { relayedBy: 'member-2', words: '下次也这样做',
        messageRef: { source: 'synthetic', at: '2026-02-02T00:00:00.000Z' } },
      delivery: { conversationId: 'conversation-source-synthetic', revision: 1 },
      lesson: { trigger: 'Before a synthetic release is approved', scope: 'A synthetic build under review',
        pitfalls: ['Never skip the synthetic diff'], acceptanceEvidence: ['The synthetic risk list was read'] }
    });
  }

  if (inactive) {
    worldIn.workflows.propose({ personalSpaceId: SPACE, agentId: 'member-1', personalProjectId: SOURCE }, {
      name: 'Abandoned synthetic idea', purpose: 'A proposal the person never confirmed',
      steps: [{ title: 'Do not export this' }], source: 'agent'
    });
    worldIn.assignments.register({ personalSpaceId: SPACE, projectId: SOURCE, leadAgentId: 'outsider-1',
      terms: ['unrelated archive'], responsibility: 'Keep an unrelated archive', preferenceIds: [],
      source: 'host', sourceConversationId: null });
  }

  return worldIn;
}

// An empty project the template is imported into, with its own stores.
export function targetWorld(t, options = {}) {
  return world(t, { projects: [{ projectId: TARGET, profile: { name: 'Synthetic target' } }], ...options });
}

// The normal entry staffs a default lead on the target's first task, before a
// person can preview: a durable Agent with the generic lead occupation, one
// assignment whose reason says why it exists, and no other configured team.
// The first write is revision 0 with the same assigned/updated timestamps; a
// person's edit bumps the revision. `revision: null` spells a legacy record
// that carries no revision at all.
export function bootstrapTarget(t, { workStatus = 'idle', openTasks = 0, reason = BOOTSTRAP_REASON,
  occupation = 'lead', ended = false, policyLead = 'auto-lead', members = [],
  revision = 0, responsibility = BOOTSTRAP_RESPONSIBILITY,
  assignedAt = '2026-03-01T00:00:00.000Z', updatedAt = assignedAt } = {}) {
  const target = targetWorld(t);
  const lead = {
    agent_id: 'auto-lead',
    personal_space_id: SPACE,
    personal_project_id: null,
    profile: {
      name: 'Synthetic target 负责人',
      responsibility: BOOTSTRAP_RESPONSIBILITY,
      capabilities: [],
      initial_preferences: [],
      status: 'active',
      agent_type: 'durable'
    },
    occupation: { role: occupation, tags: [] },
    occupation_locked: false,
    assignments: [{
      assignment_id: 'assignment-auto-lead',
      personal_space_id: SPACE,
      personal_project_id: TARGET,
      agent_id: 'auto-lead',
      responsibility,
      work_kinds: ['project_context'],
      capabilities: [],
      reason,
      status: ended ? 'ended' : 'active',
      ...(revision === null ? {} : { revision }),
      assigned_at: assignedAt,
      updated_at: updatedAt,
      ...(ended ? { ended_at: '2026-03-02T00:00:00.000Z' } : {})
    }],
    work_status: workStatus,
    open_task_count: openTasks
  };
  target.provider.state.agents.set(lead.agent_id, lead);
  target.provider.state.assignments.set('bootstrap-auto-lead', lead.assignments[0]);
  target.provider.state.policies.set(TARGET, {
    personal_space_id: SPACE, personal_project_id: TARGET,
    ask_before_recruitment: false, auto_reuse_previous_agent: true, auto_grow_team: true,
    team_lead_agent_id: policyLead, team_member_agent_ids: members, sub_teams: [],
    sub_team_suggestion_threshold: 6, updated_at: '2026-03-02T00:00:00.000Z'
  });
  return { ...target, lead };
}

export async function exportedTemplate(app) {
  const { template } = await callTeamTool(app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  return template;
}
