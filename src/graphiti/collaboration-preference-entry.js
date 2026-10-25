import { captureDecision } from './capture-decision.js';
import { buildUserTasteSkill } from './user-taste-skill.js';
import {
  taskEntryPreferences,
  finishTaskEntryPreferences
} from './task-entry-preferences.js';
import { TASK_ENTRY_TOOLS, registerRepositoryProject } from './repository-project-registration.js';
import { resolveTaskEntryProject } from './task-entry-project-scope.js';
import { withSharedProjectList } from './shared-project-list.js';
import { recordAgentViews } from './agent-view-records.js';
import { resolvePreferenceProject } from './preference-project-resolution.js';

// A task entry reads the project list once (shared-project-list.js).
export function collaborationPreferencesAtEntry(application, input) {
  return withSharedProjectList(() => collaborationPreferences(application, input));
}

async function collaborationPreferences(application, {
  personalProjectId = null,
  projectAgentId = null,
  projectPath = null,
  taskPrompt = null,
  sourceApplication = 'other',
  sourceSessionId = null,
  sessionId = null,
  turnId = null,
  workKind = null,
  workflow = null,
  requiredCapabilities = [],
  limit = 100,
  agentInvocation = false,
  agentToolName = 'get_collaboration_preferences'
} = {}) {
  let projectResolution = await resolvePreferenceProject(application, { personalProjectId, projectPath });
  if (projectResolution.repositoryProjectId && agentInvocation && TASK_ENTRY_TOOLS.has(agentToolName)
    && (await captureDecision(application, { sourceApplication, projectPath, sessionId,
      personalProjectId: projectResolution.repositoryProjectId })).allowed) {
    // Every task gets a FULI Agent, so a task in an unregistered repository
    // registers it, unless neither the folder nor the project it would
    // become is recorded.
    projectResolution = await registerRepositoryProject(application, projectResolution, { sessionId, projectPath });
  }
  projectResolution = await resolveTaskEntryProject(application, projectResolution, {
    sessionId, sourceSessionId, sourceApplication, agentInvocation, agentToolName, projectAgentId, taskPrompt
  });
  const preferences = await taskEntryPreferences(application, projectResolution, {
    personalProjectId, projectAgentId, projectPath, taskPrompt, sourceApplication,
    sourceSessionId, sessionId, turnId, workKind, workflow, requiredCapabilities,
    limit, agentInvocation, agentToolName
  }, (items, toolName) => recordAgentViews(application, items, toolName, { sourceApplication, projectPath,
    personalProjectId: projectResolution.personalProjectId, sessionId: sessionId ?? sourceSessionId }));
  return finishTaskEntryPreferences(application, preferences, { agentInvocation, agentToolName,
    sessionId, sourceApplication, sourceSessionId, taskPrompt, workKind, workflow });
}

export async function getUserTasteSkill(application, {
  personalProjectId = null,
  projectPath = null,
  taskPrompt = null,
  limit = 100,
  sourceApplication = 'other'
} = {}) {
  const context = await application.getCollaborationPreferences({
    personalProjectId,
    projectPath,
    taskPrompt,
    limit,
    sourceApplication,
    agentInvocation: true,
    agentToolName: 'get_user_taste_skill'
  });
  const skill = buildUserTasteSkill({
    preferences: context.effective_preferences,
    taskPrompt,
    personalSpaceId: context.context.personal_space_id,
    personalProjectId: context.context.personal_project_id
  });
  return {
    status: 'generated',
    ...skill,
    agent_receipt: context.agent_receipt,
    ...(context.task_knowledge_recall
      ? { task_knowledge_recall: context.task_knowledge_recall }
      : {}),
    application_guidance: context.application_guidance,
    deferred_conflicts: context.deferred_conflicts,
    context: context.context
  };
}
