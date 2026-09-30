import { verificationPreference } from './verification-preference.js';
// Capability matching returns public assignment metadata, never peer memory.
export async function planAgentCollaboration(application, input) {
  const task = await application.taskContextRegistry.context(input.taskContextToken, input.sourceApplication);
  if (!task.projectAgentId || !task.personalProjectId) return { status: 'unassigned', executionStarted: false };
  const spaceId = application.config.personal.spaceId;
  const [agents, policy, executors, loans, rules, currentAgent] = await Promise.all([
    application.personal.listProjectAgents(spaceId, null, { status: 'active' }),
    application.personal.getProjectAgentCoordinationPolicy(spaceId, task.personalProjectId),
    application.listExecutors({ personalSpaceId: spaceId }),
    application.personal.agentLoan('query', { personal_space_id: spaceId, personal_project_id: task.personalProjectId }),
    application.listExecutorRoutingRules({ personalSpaceId: spaceId, status: 'active' }),
    application.getProjectAgent({ personalSpaceId: spaceId, personalProjectId: task.personalProjectId, agentId: task.projectAgentId })
  ]);
  const required = (input.requiredCapabilities ?? []).map(value => value.toLowerCase());
  const candidates = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent.profile?.allowed_clients?.includes(input.sourceApplication)) continue;
    for (const assignment of agent.assignments ?? []) {
      if (assignment.status !== 'active') continue;
      const capabilities = [...(assignment.capabilities ?? []), ...(agent.profile?.capabilities ?? [])].map(value => value.toLowerCase());
      if (!required.every(value => capabilities.includes(value))) continue;
      const workMatch = [...(assignment.work_kinds ?? []), ...(agent.profile?.work_kinds ?? [])].includes(input.workKind);
      if (!workMatch && !required.length) continue;
      candidates.push({ agentId: agent.agent_id, name: agent.profile?.display_name || agent.profile?.name,
        projectId: assignment.personal_project_id, capabilities: assignment.capabilities ?? [],
        requiresLoan: assignment.personal_project_id !== task.personalProjectId,
        workMatch, activeTasks: agent.open_task_count ?? 0 });
    }
  }
  candidates.sort((a, b) => Number(a.requiresLoan) - Number(b.requiresLoan) || Number(b.workMatch) - Number(a.workMatch)
    || a.activeTasks - b.activeTasks || a.agentId.localeCompare(b.agentId));
  return { teamLeadId: policy.team_lead_agent_id, currentAgentId: task.projectAgentId,
    candidates: candidates.slice(0, 8), pendingLoans: loans.loans?.filter(loan => loan.status === 'requested') ?? [],
    executionStarted: false,
    preferencePrompt: verificationPreference({ executors, rules, projectId: task.personalProjectId,
      lockedExecutorIds: currentAgent.profile?.executorPolicy?.mode === 'locked' ? currentAgent.profile.executorPolicy.lockedExecutorIds : null }),
    guidance: 'Keep the project lead as owner. Choose a qualified specialist. For another project, the destination lead calls request_agent_loan; the source lead approves with decide_agent_loan in its own scoped task. Then coordinate_project_agent_task with the borrowed Agent. Share only the bounded task brief and authorized artifacts. Record actual workers. Verify each artifact; use record_agent_verification. Two failed attempts at one capability tier require escalation, not another identical retry. A selected model is not proof of execution or success.' };
}

export async function agentLoan(application, operation, input) {
  const request = { personal_space_id: application.config.personal.spaceId };
  if (operation === 'query') request.personal_project_id = input.personalProjectId;
  else {
    request.task_context_token = input.taskContextToken;
    request.source_application = input.sourceApplication;
  }
  if (operation === 'request') Object.assign(request, { source_project_id: input.sourceProjectId,
    specialist_id: input.specialistId, target_task_id: input.targetTaskId,
    objective: input.objective, idempotency_key: input.idempotencyKey });
  if (operation === 'decide') Object.assign(request, { loan_id: input.loanId, decision: input.decision });
  return application.personal.agentLoan(operation, request);
}

export async function agentVerification(application, operation, input) {
  const request = { personal_space_id: application.config.personal.spaceId,
    personal_project_id: input.personalProjectId, task_id: input.taskId, artifact_revision: input.artifactRevision };
  if (operation === 'record') Object.assign(request, { task_context_token: input.taskContextToken,
    source_application: input.sourceApplication, attempt_id: input.attemptId, outcome: input.outcome,
    evidence_refs: input.evidenceRefs, run_id: input.runId, executor_id: input.executorId, provider: input.provider, model: input.model });
  return application.personal.agentVerification(operation, request);
}
