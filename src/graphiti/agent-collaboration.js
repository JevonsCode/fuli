import { verificationPreference } from './verification-preference.js';
import { executionPlan } from './execution-mode.js';
const lower = values => (values ?? []).map(value => String(value).toLowerCase());
// Matches Provider staffing: a nonempty assignment list overrides the profile list.
const effective = (assignment, profile, field) => lower(assignment[field]?.length ? assignment[field] : profile?.[field]);
const verificationKinds = new Set(['test_validation', 'verification', 'code_review']);

function matchCandidates(agents, task, input) {
  const required = lower(input.requiredCapabilities);
  const workKind = String(input.workKind).toLowerCase();
  const candidates = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    for (const assignment of agent.assignments ?? []) {
      if (assignment.status !== 'active') continue;
      const capabilities = effective(assignment, agent.profile, 'capabilities');
      if (!required.every(value => capabilities.includes(value))) continue;
      const workMatch = effective(assignment, agent.profile, 'work_kinds').includes(workKind);
      if (!workMatch && !required.length) continue;
      candidates.push({ agentId: agent.agent_id, name: agent.profile?.display_name || agent.profile?.name,
        projectId: assignment.personal_project_id, capabilities,
        allowedClients: agent.profile?.allowed_clients ?? [],
        clientAvailable: Boolean(agent.profile?.allowed_clients?.includes(input.sourceApplication)),
        ...(assignment.responsibility ? { responsibility: assignment.responsibility } : {}),
        requiresLoan: assignment.personal_project_id !== task.personalProjectId,
        workMatch, activeTasks: agent.open_task_count ?? 0 });
    }
  }
  return candidates;
}

function nextSteps(candidate, taskContextToken, sourceLeadId, personalProjectId) {
  const steps = { ask: { tool: 'message_agent', arguments: { to: candidate.agentId }, advisoryOnly: true,
    guidance: 'A roundtable answer is advice from a read-only session, not executed work.' } };
  if (candidate.requiresLoan) {
    steps.borrow = { tool: 'request_agent_loan', arguments: { sourceProjectId: candidate.projectId, specialistId: candidate.agentId },
      requires: ['targetTaskId', 'objective', 'idempotencyKey'], approvalBy: sourceLeadId,
      guidance: 'Only the destination project lead may request. The source lead approves with decide_agent_loan in its own task context before any assignment or execution.' };
  }
  steps.execute = { tool: 'coordinate_project_agent_task',
    arguments: { taskContextToken, personalProjectId, collaboratorAgentIds: [candidate.agentId] },
    guidance: `${candidate.requiresLoan ? 'After the loan is approved, ' : ''}coordinate under the project lead with an authorized runtime; record the actual worker and result back to the lead.` };
  return steps;
}

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
  const verificationOnly = verificationKinds.has(String(input.workKind).toLowerCase());
  const independentAcceptance = verificationOnly && input.taskSize !== 'small';
  const separated = input.taskSize !== 'small' && !verificationOnly;
  const independent = separated && input.taskSize === 'complex' ? input.independentWork : null;
  const verification = { workKind: input.verificationWorkKind ?? 'test_validation',
    requiredCapabilities: input.verificationCapabilities ?? [] };
  const pools = { main: matchCandidates(agents, task, input),
    independent: independent ? matchCandidates(agents, task, { ...input, ...independent,
      requiredCapabilities: independent.requiredCapabilities ?? [] }) : [],
    verification: separated ? matchCandidates(agents, task, { ...input, ...verification }) : [] };
  // A loan needs the source project's lead, who itself cannot be borrowed.
  const sourceProjects = [...new Set(Object.values(pools).flat().filter(item => item.requiresLoan).map(item => item.projectId))];
  const sourceLeads = Object.fromEntries(await Promise.all(sourceProjects.map(async projectId => [projectId,
    (await application.personal.getProjectAgentCoordinationPolicy(spaceId, projectId))?.team_lead_agent_id ?? null])));
  const token = input.taskContextToken;
  const eligible = (pool, excluded = [], available = true) => pool.filter(item => item.clientAvailable === available && !excluded.includes(item.agentId)
    && (!item.requiresLoan || (sourceLeads[item.projectId] && sourceLeads[item.projectId] !== item.agentId)))
    .sort((a, b) => Number(a.requiresLoan) - Number(b.requiresLoan) || Number(b.workMatch) - Number(a.workMatch)
      || a.activeTasks - b.activeTasks || a.agentId.localeCompare(b.agentId));
  const authors = [...new Set([task.projectAgentId, ...(input.implementationAgentIds ?? [])])];
  const mainCandidates = eligible(pools.main, independentAcceptance ? authors : []);
  const unavailableCandidates = eligible(pools.main, independentAcceptance ? authors : [], false);
  const shown = mainCandidates.slice(0, 8).map(item => ({ ...item,
    ...(item.requiresLoan ? { sourceLeadId: sourceLeads[item.projectId] } : {}),
    nextSteps: nextSteps(item, token, sourceLeads[item.projectId], task.personalProjectId) }));
  const preferencePrompt = verificationPreference({ executors, rules, projectId: task.personalProjectId,
    lockedExecutorIds: currentAgent.profile?.executorPolicy?.mode === 'locked' ? currentAgent.profile.executorPolicy.lockedExecutorIds : null });
  const judgmentPolicy = await application.judgment?.policy({ personalSpaceId: spaceId, personalProjectId: task.personalProjectId });
  if (judgmentPolicy && judgmentPolicy.mode !== 'manual' && preferencePrompt.choiceSource !== 'user_rule') {
    Object.assign(preferencePrompt, { shouldAsk: false, recommendedExecutorId: null, choiceSource: 'tonborg',
      guidance: 'The user delegated routine executor choices to Tonborg. Call assess_agent_action for the selected specialist before dispatch; ask only when its outcome requires user input. Recheck runtime availability and preserve the real execution receipt.' });
  }
  // No qualified specialist: hand off to the existing task coordination path,
  // which opens one deduplicated HR recruitment under the project policy.
  const recruit = stream => ({ tool: 'coordinate_project_agent_task',
    arguments: { taskContextToken: token, personalProjectId: task.personalProjectId,
      workKind: stream.workKind, requiredCapabilities: stream.requiredCapabilities ?? [],
      staffingIntent: 'new_durable' },
    requires: ['idempotencyKey', 'title', 'objective', 'routingReason', 'contextQueries'],
    coordinatorAgentId: policy.team_lead_agent_id ?? null, askBeforeRecruitment: policy.ask_before_recruitment !== false,
    guidance: 'Reuse one stable idempotencyKey for this staffing need so a retry reuses the same recruitment. When askBeforeRecruitment is true, AR only proposes a hire; confirm with the user before it is staffed. Recruiting executes nothing.' });
  const recruitment = shown.length || unavailableCandidates.length ? null : recruit(input);
  const coordinatorAgentId = policy.team_lead_agent_id ?? task.projectAgentId;
  function workstream(id, spec, candidate, dependsOn = [], unavailable = []) {
    const continuing = id === 'main' && !independentAcceptance && candidate?.agentId === task.projectAgentId;
    const blocked = !candidate && unavailable.length > 0;
    const dispatch = continuing || blocked ? null : candidate ? { tool: 'coordinate_project_agent_task',
      arguments: { taskContextToken: token, workKind: spec.workKind, requiredCapabilities: spec.requiredCapabilities ?? [],
        leadAgentId: candidate.agentId },
      requires: ['idempotencyKey', 'title', 'objective', 'contextQueries'] } : recruit(spec);
    if (dispatch) Object.assign(dispatch.arguments, { personalProjectId: task.personalProjectId, coordinatorAgentId, contextLimitPerQuery: 3,
      routingReason: `Bounded ${id} workstream; ${dependsOn.length ? 'independent acceptance after stable artifacts' : 'explicit scope'}; report evidence to the project lead.`,
      ...(spec.contextQueries ? { contextQueries: spec.contextQueries } : {}) });
    return { id, workKind: spec.workKind, agentId: candidate?.agentId ?? null,
      boundary: spec.boundary ?? (verificationOnly || id === 'verification'
        ? '独立检查约定产物与验收条件，返回问题、命令和结果；不改动主线实现。'
        : '负责主线实施与集成；独立工作包之外的修改由此处统一处理。'),
      action: continuing ? 'continue_current' : blocked ? 'blocked' : candidate?.requiresLoan ? 'request_loan' : candidate ? 'delegate' : 'recruit',
      dependsOn, startWhen: dependsOn.length ? 'artifacts_ready' : 'now', dispatch,
      ...(blocked ? { blockedReason: 'qualified_agent_client_unavailable', unavailableCandidates: unavailable,
        guidance: 'A qualified FLA exists but cannot use this client. Select an already authorized eligible client with assess_agent_action or report the constraint; do not recruit a replacement or relax its allowed clients.' } : {}),
      ...(candidate?.requiresLoan ? { borrow: nextSteps(candidate, token, sourceLeads[candidate.projectId], task.personalProjectId).borrow } : {}) };
  }
  const main = !independentAcceptance && mainCandidates.find(candidate => candidate.agentId === task.projectAgentId)
    || mainCandidates[0];
  const workstreams = [workstream('main', input, main, [], unavailableCandidates)];
  if (independent) {
    const excluded = [...authors, main?.agentId];
    workstreams.push(workstream('independent', independent, eligible(pools.independent, excluded)[0], [],
      eligible(pools.independent, excluded, false)));
  }
  if (separated) {
    const excluded = [...authors, ...workstreams.map(stream => stream.agentId)];
    workstreams.push(workstream('verification', verification, eligible(pools.verification, excluded)[0],
      workstreams.map(stream => stream.id), eligible(pools.verification, excluded, false)));
  }
  const divisionPlan = { mode: separated ? 'separated' : 'single', coordinatorAgentId, workstreams,
    execution: executionPlan(workstreams, input.hostExecutionModes, token),
    reason: separated ? (independent ? '复杂任务有明确独立边界，拆为两个执行工作包和一份独立验收。'
      : '主线延续当前上下文，另一个 FLA 在产物稳定后独立验收，减少重复阅读。')
      : independentAcceptance ? '这是独立验收工作包，排除已知实现者，不再递归拆分。'
      : '小改动或只运行已有命令保持一个工作包，避免委派成本超过收益。',
    contextPolicy: { inheritConversation: false, limitPerQuery: 3,
      brief: 'Only the objective, scope, authorized artifact references, acceptance criteria and necessary queries. Return a concise result and reproducible evidence; request missing context specifically.' },
    modelPolicy: 'Use the existing authorized model strategy and assess_agent_action. Prefer balanced capability for bounded work unless explicit quality requirements or failed verification demand more. Never invent prices or token savings.',
    guidance: 'The lead owns decomposition, integration and delivery. Re-plan if actual implementers change and pass every implementationAgentId. Wait for stable artifacts before independent acceptance; independent roles do not imply simultaneous execution. A loan must be approved before dispatch. Record the workstream reason and real worker/model/usage in existing task activity; missing token usage stays unknown.' };
  return { status: shown.length ? 'specialists_available' : unavailableCandidates.length ? 'specialist_client_unavailable' : 'no_qualified_specialist',
    teamLeadId: policy.team_lead_agent_id, currentAgentId: task.projectAgentId,
    candidates: shown, unavailableCandidates, recruitment, pendingLoans: loans.loans?.filter(loan => loan.status === 'requested') ?? [],
    executionStarted: false,
    preferencePrompt, divisionPlan,
    guidance: 'Keep the project lead as owner. Choose a qualified specialist. Discovery and roundtable answers are advisory and are not executed work. For another project, the destination lead calls request_agent_loan; the source lead approves with decide_agent_loan in its own scoped task. Then coordinate_project_agent_task with the borrowed Agent. Share only the bounded task brief and authorized artifacts. Workers report results to the project lead; record actual workers. Verify each artifact; use record_agent_verification. Two failed attempts at one capability tier require escalation, not another identical retry. A selected model is not proof of execution or success.' };
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
