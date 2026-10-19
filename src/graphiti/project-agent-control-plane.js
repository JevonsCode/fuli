import { withOccupationDemand } from './occupation-staffing.js';
import { occupationCatalog } from './occupation-catalog.js';
import { workerRunRecord } from './worker-run-view.js';
import { retryProjectAgentTask, stopProjectAgentTaskRun } from './project-agent-run-control.js';
import { planAgentCollaboration, agentLoan, agentVerification } from './agent-collaboration.js';
import { queryConversations, resumeConversation, updateConversationPolicy } from './agent-conversations.js';
import { recordUserTriage } from './conversation-triage.js';
import { acceptTopicProposal, declineTopicProposal, listTopicProposals } from './topic-proposals.js';
import { agentProjectResolution } from './agent-knowledge-workflows.js';
import { listAgentAttention, changeAgentAttention, respondToAgentAttention } from './agent-attention.js';
import { loadProjectTeam } from './project-team-view.js';
import { dismissProjectAgent, getAgentHandoff, listAgentDismissalLessons } from './project-agent-dismissal.js';
import {
  getProjectAgentMemory,
  inspectProjectAgentMemory,
  checkpointProjectAgentMemory,
  exportProjectAgentMemory,
  exportInspectedProjectAgentMemory
} from './project-agent-memory.js';
import {
  authorizeExecutor as authorizeExecutorWorkflow,
  cleanupProjectAgentTestRoles as cleanupProjectAgentTestRolesWorkflow,
  coordinateProjectAgentTask as coordinateProjectAgentTaskWorkflow,
  createProjectAgentAssignment as createProjectAgentAssignmentWorkflow,
  decideProjectAgentRecruitment as decideProjectAgentRecruitmentWorkflow,
  deleteExecutor as deleteExecutorWorkflow,
  deleteExecutorRoutingRule as deleteExecutorRoutingRuleWorkflow,
  archiveTestProjectAgent as archiveTestProjectAgentWorkflow,
  updateProjectAgentOccupation as updateProjectAgentOccupationWorkflow,
  endProjectAgentAssignment as endProjectAgentAssignmentWorkflow,
  getExecutor as getExecutorWorkflow,
  getExecutorRoutingRule as getExecutorRoutingRuleWorkflow,
  getProjectAgent as getProjectAgentWorkflow,
  getProjectAgentContext as getProjectAgentContextWorkflow,
  getProjectAgentCoordinationPolicy as getProjectAgentCoordinationPolicyWorkflow,
  getProjectAgentRecruitmentPolicy as getProjectAgentRecruitmentPolicyWorkflow,
  ignoreProjectAgentRoutingLearning as ignoreProjectAgentRoutingLearningWorkflow,
  listCurrentProjectAgents as listCurrentProjectAgentsWorkflow,
  listExecutorRoutingRules as listExecutorRoutingRulesWorkflow,
  listExecutors as listExecutorsWorkflow,
  listProjectAgentAssignments as listProjectAgentAssignmentsWorkflow,
  listProjectAgentRecruitments as listProjectAgentRecruitmentsWorkflow,
  listProjectAgentRoutingLearning as listProjectAgentRoutingLearningWorkflow,
  listProjectAgentTasks as listProjectAgentTasksWorkflow,
  listProjectAgents as listProjectAgentsWorkflow,
  listProjectAgentPage as listProjectAgentPageWorkflow,
  preflightExecutor as preflightExecutorWorkflow,
  recordProjectAgentExecutorActual as recordProjectAgentExecutorActualWorkflow,
  recordProjectAgentTaskActivity as recordProjectAgentTaskActivityWorkflow,
  recordProjectAgentTaskOutcome as recordProjectAgentTaskOutcomeWorkflow,
  replaceProjectAgentAssignment as replaceProjectAgentAssignmentWorkflow,
  reportExecutorHealth as reportExecutorHealthWorkflow,
  resetProjectAgentRoutingLearning as resetProjectAgentRoutingLearningWorkflow,
  submitProjectAgentTask as submitProjectAgentTaskWorkflow,
  updateExecutorRoutingRule as updateExecutorRoutingRuleWorkflow,
  updateProjectAgentCoordinationPolicy as updateProjectAgentCoordinationPolicyWorkflow,
  updateProjectAgentRecruitmentPolicy as updateProjectAgentRecruitmentPolicyWorkflow,
  upsertExecutor as upsertExecutorWorkflow,
  upsertExecutorRoutingRule as upsertExecutorRoutingRuleWorkflow,
  upsertProjectAgent as upsertProjectAgentWorkflow,
  viewProjectAgentActivity as viewProjectAgentActivityWorkflow,
  viewProjectAgentTask as viewProjectAgentTaskWorkflow
} from './project-agent-workflows.js';

export const projectAgentControlPlaneHooks = Object.freeze({
  assertActivePersonalSpace: Symbol('assertActivePersonalSpace'),
  resolvePreferenceProject: Symbol('resolvePreferenceProject')
});

export class ProjectAgentControlPlaneApplication {
  async occupationCatalog(operation, input) {
    this.#assertSpace(input.personalSpaceId);
    return occupationCatalog(this, operation, input);
  }
  async agentVerification(operation, input) {
    this.#assertSpace(input.personalSpaceId);
    return agentVerification(this, operation, input);
  }
  async planAgentCollaboration(input) {
    return withOccupationDemand(this, input, await planAgentCollaboration(this, input));
  }
  async agentLoan(operation, input) {
    if (input.personalSpaceId) this.#assertSpace(input.personalSpaceId);
    return agentLoan(this, operation, input);
  }
  async recordConversationTriage(input) {
    this.#assertSpace(input.personalSpaceId);
    return recordUserTriage(this, input);
  }
  async topicProposals(operation, input) {
    this.#assertSpace(input.personalSpaceId);
    if (operation === 'list') return listTopicProposals(this);
    if (operation === 'accept') return acceptTopicProposal(this, { topic: input.topic });
    return declineTopicProposal(this, { topic: input.topic });
  }
  async queryAgentConversations(input) {
    this.#assertSpace(input.personalSpaceId);
    return queryConversations(this, input);
  }
  async resumeAgentConversation(input) { return resumeConversation(this, input); }
  async updateAgentConversationPolicy(input) {
    this.#assertSpace(input.personalSpaceId);
    return updateConversationPolicy(this, input);
  }
  async listAgentAttention(input) {
    this.#assertSpace(input.personalSpaceId);
    return listAgentAttention(this, input);
  }

  async requestAgentAttention(input) {
    this.#assertSpace(input.personalSpaceId);
    const record = await changeAgentAttention(this, 'create', input);
    // A person is needed: tell the local notifier without waiting for it.
    void this.needsPerson?.notify(record);
    return record;
  }

  async cancelAgentAttention(input) {
    this.#assertSpace(input.personalSpaceId);
    return changeAgentAttention(this, 'cancel', input);
  }

  async respondToAgentAttention(input) {
    this.#assertSpace(input.personalSpaceId);
    return respondToAgentAttention(this, input);
  }

  async getProjectAgentMemory(input) {
    this.#assertSpace(input.personalSpaceId);
    return getProjectAgentMemory(this, input);
  }

  async inspectProjectAgentMemory(input) {
    // The local owner's console can inspect its employees independently of
    // which model clients an employee is allowed to run in. Provider access
    // still validates the exact personal space, project and assignment.
    this.#assertSpace(input.personalSpaceId);
    return inspectProjectAgentMemory(this, input);
  }

  async checkpointProjectAgentMemory(input) {
    this.#assertSpace(input.personalSpaceId);
    return checkpointProjectAgentMemory(this, input);
  }

  async exportProjectAgentMemory(input) {
    this.#assertSpace(input.personalSpaceId);
    return exportProjectAgentMemory(this, input);
  }

  async exportInspectedProjectAgentMemory(input) {
    // Same owner authority as inspectProjectAgentMemory.
    this.#assertSpace(input.personalSpaceId);
    return exportInspectedProjectAgentMemory(this, input);
  }

  async upsertProjectAgent(input) {
    this.#assertSpace(input.personalSpaceId);
    return upsertProjectAgentWorkflow(this, input);
  }

  async listProjectAgents(input) {
    this.#assertSpace(input.personalSpaceId);
    return listProjectAgentsWorkflow(this, input);
  }

  async listProjectAgentPage(input) {
    this.#assertSpace(input.personalSpaceId);
    return listProjectAgentPageWorkflow(this, input);
  }

  async listCurrentProjectAgents(input) {
    const resolution = await this.#resolveProject(input.projectPath, input.personalProjectId ?? null);
    return listCurrentProjectAgentsWorkflow(
      this,
      agentProjectResolution(resolution),
      input
    );
  }

  async getProjectAgent(input) {
    this.#assertSpace(input.personalSpaceId);
    return getProjectAgentWorkflow(this, input);
  }

  async archiveTestProjectAgent(input) {
    this.#assertSpace(input.personalSpaceId);
    return archiveTestProjectAgentWorkflow(this, input);
  }

  async dismissProjectAgent(input) {
    this.#assertSpace(input.personalSpaceId);
    return dismissProjectAgent(this, input);
  }

  async listAgentDismissalLessons(input) {
    this.#assertSpace(input.personalSpaceId);
    return listAgentDismissalLessons(this, input);
  }

  async getAgentHandoff(input) {
    this.#assertSpace(input.personalSpaceId);
    return getAgentHandoff(this, input);
  }

  async updateProjectAgentOccupation(input) {
    this.#assertSpace(input.personalSpaceId);
    return updateProjectAgentOccupationWorkflow(this, input);
  }

  async cleanupProjectAgentTestRoles(input) {
    this.#assertSpace(input.personalSpaceId);
    return cleanupProjectAgentTestRolesWorkflow(this, input);
  }

  async createProjectAgentAssignment(input) {
    this.#assertSpace(input.personalSpaceId);
    return createProjectAgentAssignmentWorkflow(this, input);
  }

  async listProjectAgentAssignments(input) {
    this.#assertSpace(input.personalSpaceId);
    return listProjectAgentAssignmentsWorkflow(this, input);
  }

  async endProjectAgentAssignment(input) {
    this.#assertSpace(input.personalSpaceId);
    return endProjectAgentAssignmentWorkflow(this, input);
  }

  async replaceProjectAgentAssignment(input) {
    this.#assertSpace(input.personalSpaceId);
    return replaceProjectAgentAssignmentWorkflow(this, input);
  }

  async submitProjectAgentTask(input) {
    this.#assertSpace(input.personalSpaceId);
    return submitProjectAgentTaskWorkflow(this, input);
  }

  async coordinateProjectAgentTask(input) {
    const resolution = await this.#resolveProject(input.projectPath, input.personalProjectId ?? null);
    return coordinateProjectAgentTaskWorkflow(
      this,
      agentProjectResolution(resolution),
      input
    );
  }

  async listProjectAgentTasks(input) {
    this.#assertSpace(input.personalSpaceId);
    return listProjectAgentTasksWorkflow(this, input);
  }

  async viewProjectAgentTask(input) {
    this.#assertSpace(input.personalSpaceId);
    return viewProjectAgentTaskWorkflow(this, input);
  }

  async listProjectAgentTaskRuns(input) {
    this.#assertSpace(input.personalSpaceId);
    const history = await this.personal.listProjectAgentTaskRuns(input);
    return { runs: history.runs.map(workerRunRecord), nextCursor: history.next_cursor, complete: history.complete };
  }

  // F-P2-05 ⑦: stop a running run, retry a terminal task as new work, replay run history.
  async controlProjectAgentTaskRun(input) {
    this.#assertSpace(input.personalSpaceId);
    if (input.action === 'stop') return stopProjectAgentTaskRun(this, input);
    if (input.action === 'retry') return retryProjectAgentTask(this, input);
    if (input.action === 'history') return this.listProjectAgentTaskRuns(input);
    throw new TypeError('action must be stop, retry or history');
  }

  openProjectAgentTaskEvents(input, options) {
    this.#assertSpace(input.personalSpaceId);
    return this.personal.openProjectAgentTaskEvents(input.personalSpaceId, options);
  }

  async recordProjectAgentTaskActivity(input) {
    this.#assertSpace(input.personalSpaceId);
    return recordProjectAgentTaskActivityWorkflow(this, input);
  }

  async viewProjectAgentActivity(input) {
    this.#assertSpace(input.personalSpaceId);
    return viewProjectAgentActivityWorkflow(this, input);
  }

  async getProjectAgentCoordinationPolicy(input) {
    this.#assertSpace(input.personalSpaceId);
    return getProjectAgentCoordinationPolicyWorkflow(this, input);
  }

  async getProjectTeam(input) {
    this.#assertSpace(input.personalSpaceId);
    if (!input.personalProjectId) throw new TypeError('personalProjectId is required');
    return loadProjectTeam(this, input.personalSpaceId, input.personalProjectId);
  }

  async updateProjectAgentCoordinationPolicy(input) {
    this.#assertSpace(input.personalSpaceId);
    return updateProjectAgentCoordinationPolicyWorkflow(this, input);
  }

  async getProjectAgentRecruitmentPolicy(input) {
    this.#assertSpace(input.personalSpaceId);
    return getProjectAgentRecruitmentPolicyWorkflow(this, input);
  }

  async updateProjectAgentRecruitmentPolicy(input) {
    this.#assertSpace(input.personalSpaceId);
    return updateProjectAgentRecruitmentPolicyWorkflow(this, input);
  }

  async listProjectAgentRecruitments(input) {
    this.#assertSpace(input.personalSpaceId);
    return listProjectAgentRecruitmentsWorkflow(this, input);
  }

  async decideProjectAgentRecruitment(input) {
    this.#assertSpace(input.personalSpaceId);
    return decideProjectAgentRecruitmentWorkflow(this, input);
  }

  async upsertExecutor(input) {
    this.#assertSpace(input.personalSpaceId);
    return upsertExecutorWorkflow(this, input);
  }

  async listExecutors(input) {
    this.#assertSpace(input.personalSpaceId);
    return listExecutorsWorkflow(this, input);
  }

  async getExecutor(input) {
    this.#assertSpace(input.personalSpaceId);
    return getExecutorWorkflow(this, input);
  }

  async deleteExecutor(input) {
    this.#assertSpace(input.personalSpaceId);
    return deleteExecutorWorkflow(this, input);
  }

  async preflightExecutor(input) {
    this.#assertSpace(input.personalSpaceId);
    return preflightExecutorWorkflow(this, input);
  }

  async authorizeExecutor(input) {
    this.#assertSpace(input.personalSpaceId);
    return authorizeExecutorWorkflow(this, input);
  }

  async reportExecutorHealth(input) {
    this.#assertSpace(input.personalSpaceId);
    return reportExecutorHealthWorkflow(this, input);
  }

  async recordProjectAgentExecutorActual(input) {
    this.#assertSpace(input.personalSpaceId);
    return recordProjectAgentExecutorActualWorkflow(this, input);
  }

  async upsertExecutorRoutingRule(input) {
    this.#assertSpace(input.personalSpaceId);
    return upsertExecutorRoutingRuleWorkflow(this, input);
  }

  async updateExecutorRoutingRule(input) {
    this.#assertSpace(input.personalSpaceId);
    return updateExecutorRoutingRuleWorkflow(this, input);
  }

  async listExecutorRoutingRules(input) {
    this.#assertSpace(input.personalSpaceId);
    return listExecutorRoutingRulesWorkflow(this, input);
  }

  async getExecutorRoutingRule(input) {
    this.#assertSpace(input.personalSpaceId);
    return getExecutorRoutingRuleWorkflow(this, input);
  }

  async deleteExecutorRoutingRule(input) {
    this.#assertSpace(input.personalSpaceId);
    return deleteExecutorRoutingRuleWorkflow(this, input);
  }

  async recordProjectAgentTaskOutcome(input) {
    this.#assertSpace(input.personalSpaceId);
    return recordProjectAgentTaskOutcomeWorkflow(this, input);
  }

  async listProjectAgentRoutingLearning(input) {
    this.#assertSpace(input.personalSpaceId);
    return listProjectAgentRoutingLearningWorkflow(this, input);
  }

  async ignoreProjectAgentRoutingLearning(input) {
    this.#assertSpace(input.personalSpaceId);
    return ignoreProjectAgentRoutingLearningWorkflow(this, input);
  }

  async resetProjectAgentRoutingLearning(input) {
    this.#assertSpace(input.personalSpaceId);
    return resetProjectAgentRoutingLearningWorkflow(this, input);
  }

  async getProjectAgentContext(input) {
    const resolution = await this.#resolveProject(
      input.projectPath,
      input.personalProjectId ?? null
    );
    return getProjectAgentContextWorkflow(
      this,
      agentProjectResolution(resolution),
      input
    );
  }

  #assertSpace(personalSpaceId) {
    this[projectAgentControlPlaneHooks.assertActivePersonalSpace](
      personalSpaceId
    );
  }

  #resolveProject(projectPath, personalProjectId = null) {
    return this[projectAgentControlPlaneHooks.resolvePreferenceProject]({
      personalProjectId,
      projectPath
    });
  }
}
