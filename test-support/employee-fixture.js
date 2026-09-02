import { createEmployeeService } from '../src/employees/service.js';

// Synthetic, process-local FULI directory. The installed employee package and
// its SQLite board are real; no personal provider or external model is used.
export function createEmployeeFixture({ runtimeConfigPath }) {
  const agents = new Map();
  const projects = [{
    project_id: 'employee-qa', personal_space_id: 'employee-test-space',
    profile: { name: '员工招募验收（测试）', purpose: '隔离的合成测试项目', lifecycle: 'active', sources: [], boundaries: [] }
  }, {
    project_id: 'employee-qa-design', personal_space_id: 'employee-test-space',
    profile: { name: '设计系统（测试）', purpose: '合成测试项目', lifecycle: 'active', sources: [], boundaries: [] }
  }, {
    project_id: 'employee-qa-research', personal_space_id: 'employee-test-space',
    profile: { name: '产品研究（测试）', purpose: '合成测试项目', lifecycle: 'active', sources: [], boundaries: [] }
  }, {
    project_id: 'employee-qa-archive', personal_space_id: 'employee-test-space',
    profile: { name: '已归档（测试）', purpose: '合成测试项目', lifecycle: 'archived', sources: [], boundaries: [] }
  }];
  const app = {
    config: { personal: { spaceId: 'employee-test-space' } },
    async state() { return {
      mode: 'personal_only', activePersonalSpaceId: 'employee-test-space',
      personalSpaces: [{ id: 'employee-test-space', name: '隔离验收 · 合成数据' }],
      personalProjects: projects, projects: [], subscriptions: [],
      capturePolicy: { enabled: false }, agentAccessPolicy: { enabled: true },
      capabilities: { browsePublicProjects: false, submitKnowledge: false, reviewProposals: false }
    }; },
    async listPersonalProjects() { return structuredClone(projects); },
    async listCurrentProjectAgents({ projectPath }) { return { personal_project_id: projectPath === '/synthetic/employee-qa' ? 'employee-qa' : null }; },
    async listProjectAgents() { return structuredClone([...agents.values()]); },
    async upsertProjectAgent(input) {
      const now = new Date().toISOString();
      const previous = agents.get(input.agentId);
      const record = { ...input, personalProjectId: null, createdAt: previous?.createdAt ?? now, updatedAt: now, assignments: previous?.assignments ?? [] };
      agents.set(input.agentId, record);
      return structuredClone(record);
    },
    async createProjectAgentAssignment(input) {
      const record = agents.get(input.agentId);
      const existing = record.assignments.find((entry) => entry.idempotencyKey === input.idempotencyKey);
      if (existing) return structuredClone(existing);
      const now = new Date().toISOString();
      const assignment = { ...input, assignmentId: input.idempotencyKey, status: 'active', revision: 1, assignedAt: now, updatedAt: now };
      record.assignments.push(assignment);
      return structuredClone(assignment);
    },
    async getProjectAgent({ agentId }) { return structuredClone(agents.get(agentId)); },
    async endProjectAgentAssignment(input) {
      const assignment = [...agents.values()].flatMap((agent) => agent.assignments).find((entry) => entry.assignmentId === input.assignmentId);
      if (!assignment || assignment.revision !== input.expectedRevision) throw new Error('Synthetic assignment version conflict');
      assignment.status = 'ended';
      assignment.revision += 1;
      assignment.updatedAt = new Date().toISOString();
      assignment.endedAt = assignment.updatedAt;
      assignment.reason = input.reason;
      return structuredClone(assignment);
    },
    async listProjectAgentAssignments({ agentId }) { return { assignments: structuredClone(agents.get(agentId)?.assignments ?? []) }; },
    async listProjectAgentTasks() { return { tasks: [] }; },
    async viewProjectAgentActivity({ agentId }) { return { agent_id: agentId, personal_space_id: 'employee-test-space', days: [] }; },
    async listProjectAgentRecruitments() { return { recruitments: [] }; },
    async listExecutors() { return { executors: [] }; },
    async listExecutorRoutingRules() { return { rules: [] }; },
    async listProjectAgentRoutingLearning() { return []; },
    async getProjectAgentRecruitmentPolicy() { return { confirmation_mode: 'manual' }; },
    async getProjectAgentCoordinationPolicy() { return { mode: 'assist' }; },
    close() { return app.employees.close(); }
  };
  app.employees = createEmployeeService({ app, runtimeConfigPath });
  return app;
}
