import { agentProjectResolution } from './agent-knowledge-workflows.js';
import {
  authorizeExecutor as authorizeExecutorWorkflow,
  cleanupProjectAgentTestRoles as cleanupProjectAgentTestRolesWorkflow,
  coordinateProjectAgentTask as coordinateProjectAgentTaskWorkflow,
  createProjectAgentAssignment as createProjectAgentAssignmentWorkflow,
  decideProjectAgentRecruitment as decideProjectAgentRecruitmentWorkflow,
  deleteExecutor as deleteExecutorWorkflow,
  deleteExecutorRoutingRule as deleteExecutorRoutingRuleWorkflow,
  deleteProjectAgent as deleteProjectAgentWorkflow,
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
  async upsertProjectAgent(input) {
    this.#assertSpace(input.personalSpaceId);
    return upsertProjectAgentWorkflow(this, input);
  }

  async listProjectAgents(input) {
    this.#assertSpace(input.personalSpaceId);
    return listProjectAgentsWorkflow(this, input);
  }

  async listCurrentProjectAgents(input) {
    const resolution = await this.#resolveProject(input.projectPath);
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

  async deleteProjectAgent(input) {
    this.#assertSpace(input.personalSpaceId);
    return deleteProjectAgentWorkflow(this, input);
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
    const resolution = await this.#resolveProject(input.projectPath);
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
    const resolution = await this.#resolveProject(input.projectPath);
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

  #resolveProject(projectPath) {
    return this[projectAgentControlPlaneHooks.resolvePreferenceProject]({
      personalProjectId: null,
      projectPath
    });
  }
}
