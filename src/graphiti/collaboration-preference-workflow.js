import {
  agentProjectResolution
} from './agent-knowledge-workflows.js';
import {
  activePreferenceConflicts,
  agentCollaborationPreference,
  agentDeferredPreferenceConflict,
  deferredPreferenceConflicts
} from './collaboration-preference-projection.js';
import {
  recallTaskKnowledge,
  TASK_KNOWLEDGE_RETRIEVAL_GUIDANCE
} from './task-knowledge-recall.js';

export async function getCollaborationPreferences(
  application,
  projectResolution,
  {
    projectAgentId = null,
    taskPrompt = null,
    limit = 100,
    agentInvocation = false,
    agentToolName = 'get_collaboration_preferences'
  },
  recordAgentViews
) {
  const resolvedProjectId = projectResolution.personalProjectId;
  const [result, queuedConflicts] = await Promise.all([
    application.personal.collaborationPreferences(
      application.config.personal.spaceId,
      resolvedProjectId,
      limit,
      projectAgentId
    ),
    application.personal.listPreferenceConflicts(
      application.config.personal.spaceId,
      'ai_pending',
      limit
    )
  ]);
  const deferredConflicts = deferredPreferenceConflicts(
    result,
    queuedConflicts
  );
  const taskKnowledgeRecall = taskPrompt === null
    ? null
    : await recallTaskKnowledge(application, projectResolution, taskPrompt);
  if (agentInvocation) {
    const items = [
      ...(result.global_preferences ?? []),
      ...(result.project_preferences ?? []),
      ...(result.agent_preferences ?? [])
    ];
    await recordAgentViews(items.map(({ id, item_kind: itemKind }) => ({
      item_id: id,
      item_kind: itemKind
    })), agentToolName);
  }
  const applicationGuidance = guidanceFor(
    resolvedProjectId,
    projectAgentId
  );
  if (!agentInvocation) {
    return {
      ...result,
      deferred_conflicts: deferredConflicts,
      application_guidance: applicationGuidance,
      project_resolution: agentProjectResolution(projectResolution),
      ...(taskKnowledgeRecall ? { task_knowledge_recall: taskKnowledgeRecall } : {})
    };
  }
  return {
    effective_preferences: (result.effective_preferences ?? [])
      .map(agentCollaborationPreference),
    deferred_conflicts: deferredConflicts.map(agentDeferredPreferenceConflict),
    active_conflicts: activePreferenceConflicts(result),
    application_guidance: applicationGuidance,
    ...(taskKnowledgeRecall ? { task_knowledge_recall: taskKnowledgeRecall } : {}),
    context: preferenceContext(result, deferredConflicts, projectResolution)
  };
}

function guidanceFor(projectId, projectAgentId) {
  return {
    apply: 'effective_preferences',
    global_scope: 'Apply personal-global preferences in every user task.',
    project_scope: projectId
      ? `Also apply preferences scoped to ${projectId} and confirmed ancestor preferences whose descendants or selected-projects mode explicitly reaches it.`
      : 'No exact personal project matched; do not apply project-scoped preferences.',
    agent_scope: projectAgentId
      ? `Also apply preferences scoped to project Agent ${projectAgentId}; exclude every other project Agent.`
      : 'No project Agent was selected; do not apply Agent-scoped preferences.',
    inheritance: 'Project preference inheritance follows only PART_OF or USES_KNOWLEDGE_FROM for at most two hops. Preserve inherited_from_project_id, scope_path, and scope_distance. An exact item wins only after confirmation authority is compared; weight never expands scope or resolves a conflict.',
    related_projects: 'RELATED_TO preferences never auto-apply. Use structured related-project suggestions to ask before a one-time read-only expansion.',
    conflicts: 'Do not apply entries listed in conflicts until the user resolves them.',
    deferred_conflicts: 'If the current task would use a deferred_conflict, call resolve_deferred_preference_conflict before applying either side. Ignore unrelated deferred conflicts. The resolution must preserve the AI audit marker.',
    authority: 'Human or authoritative-source confirmed preferences outrank agent-confirmed preferences. Agent-confirmed preferences are usable but lower priority and remain explicitly marked.',
    pending: 'Pending preferences are available only through on-demand knowledge search; invalid and unrelated-project preferences are excluded. Automatic preference injection does not count as usage evidence.',
    knowledge_retrieval: TASK_KNOWLEDGE_RETRIEVAL_GUIDANCE
  };
}

function preferenceContext(result, deferredConflicts, projectResolution) {
  return {
    personal_space_id: result.personal_space_id,
    personal_project_id: result.personal_project_id,
    project_agent_id: result.project_agent_id ?? null,
    global_preference_count: (result.global_preferences ?? []).length,
    project_preference_count: (result.project_preferences ?? []).length,
    inherited_project_preference_count: (result.project_preferences ?? [])
      .filter(({ inherited_from_project_id: projectId }) => Boolean(projectId))
      .length,
    agent_preference_count: (result.agent_preferences ?? []).length,
    conflict_count: (result.conflicts ?? []).length,
    ai_deferred_conflict_count: deferredConflicts.length,
    overridden_global_count: (result.overridden_global_ids ?? []).length,
    overridden_project_count: (result.overridden_project_ids ?? []).length,
    source_truncated: result.truncated === true,
    project_resolution: agentProjectResolution(projectResolution)
  };
}
