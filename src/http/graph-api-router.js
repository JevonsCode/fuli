import { readJson, sendJson } from './response.js';

export async function handleGraphApiRequest({
  request,
  response,
  url,
  app
}) {
  if (url.pathname === '/api/state' && request.method === 'GET') {
    sendJson(response, 200, await app.state());
    return true;
  }
  if (url.pathname === '/api/capture-policy' && request.method === 'GET') {
    sendJson(response, 200, app.getCapturePolicy());
    return true;
  }
  if (url.pathname === '/api/capture-policy' && request.method === 'PATCH') {
    sendJson(response, 200, app.updateCapturePolicy(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/agent-access-policy' && request.method === 'GET') {
    sendJson(response, 200, app.getAgentAccessPolicy());
    return true;
  }
  if (url.pathname === '/api/agent-access-policy' && request.method === 'PATCH') {
    sendJson(response, 200, app.updateAgentAccessPolicy(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/capture' && request.method === 'POST') {
    sendJson(response, 200, await app.captureSessionKnowledge(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/search' && request.method === 'GET') {
    sendJson(response, 200, await app.searchKnowledge({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      query: url.searchParams.get('q') ?? '',
      projectIds: url.searchParams.getAll('projectId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      contextPersonalProjectIds: url.searchParams.getAll('contextPersonalProjectId'),
      limit: numberParam(url, 'limit', 12),
      includeHistorical: url.searchParams.get('historical') === 'true',
      includePending: url.searchParams.get('pending') === 'true' ||
        url.searchParams.get('exploratory') === 'true'
    }));
    return true;
  }
  if (url.pathname === '/api/graph' && request.method === 'GET') {
    sendJson(response, 200, await app.getKnowledgeGraph({
      spaceId: url.searchParams.get('spaceId'),
      providerUrl: url.searchParams.get('providerUrl'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      limit: numberParam(url, 'limit', 500),
      offset: nonNegativeNumberParam(url, 'offset', null)
    }));
    return true;
  }
  if (url.pathname === '/api/writing-taste-profile' && request.method === 'GET') {
    sendJson(response, 200, await app.getWritingTasteProfile({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      limit: numberParam(url, 'limit', 500)
    }));
    return true;
  }
  if (url.pathname === '/api/preference-conflicts' && request.method === 'GET') {
    sendJson(response, 200, await app.listPreferenceConflicts({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      status: url.searchParams.get('status'),
      limit: numberParam(url, 'limit', 500)
    }));
    return true;
  }
  if (
    url.pathname === '/api/preference-conflicts/defer'
    && request.method === 'POST'
  ) {
    sendJson(response, 200, await app.deferPreferenceConflict({
      ...(await readJson(request)),
      operationActor: 'agent'
    }));
    return true;
  }
  const completedPreferenceConflict = url.pathname.match(
    /^\/api\/preference-conflicts\/([^/]+)\/complete$/
  );
  if (completedPreferenceConflict && request.method === 'POST') {
    sendJson(response, 200, await app.completePreferenceConflict({
      ...(await readJson(request)),
      conflictId: decodeURIComponent(completedPreferenceConflict[1]),
      operationActor: 'human'
    }));
    return true;
  }
  const assignment = url.pathname.match(
    /^\/api\/knowledge\/(entity|relationship)\/([^/]+)\/assignment$/
  );
  if (assignment && request.method === 'POST') {
    sendJson(response, 200, await app.reassignKnowledgeItem({
      ...(await readJson(request)),
      itemKind: assignment[1],
      itemId: decodeURIComponent(assignment[2]),
      operationActor: 'human'
    }));
    return true;
  }
  const preferenceScope = url.pathname.match(
    /^\/api\/knowledge\/(entity|relationship)\/([^/]+)\/preference-scope$/
  );
  if (preferenceScope && request.method === 'POST') {
    sendJson(response, 200, await app.setPersonalPreferenceScope({
      ...(await readJson(request)),
      itemKind: preferenceScope[1],
      itemId: decodeURIComponent(preferenceScope[2]),
      operationActor: 'human'
    }));
    return true;
  }
  const projectAction = url.pathname.match(
    /^\/api\/knowledge\/(entity)\/([^/]+)\/project-action(\/preview)?$/
  );
  if (projectAction && request.method === 'POST') {
    const body = await readJson(request);
    const input = {
      ...body,
      itemKind: projectAction[1],
      itemId: decodeURIComponent(projectAction[2]),
      operationActor: 'human'
    };
    const result = projectAction[3]
      ? await app.previewKnowledgeProjectAction(input)
      : await app.applyKnowledgeProjectAction(input);
    sendJson(response, 200, result);
    return true;
  }
  if (url.pathname === '/api/knowledge/batch-confirmation' && request.method === 'POST') {
    sendJson(
      response,
      200,
      await app.confirmKnowledgeBatch({
        ...(await readJson(request)),
        operationActor: 'human'
      })
    );
    return true;
  }
  const knowledgeItem = url.pathname.match(
    /^\/api\/knowledge\/(entity|relationship)\/([^/]+)$/
  );
  if (knowledgeItem && request.method === 'PATCH') {
    sendJson(response, 200, await app.reviseKnowledgeItem({
      ...(await readJson(request)),
      itemKind: knowledgeItem[1],
      itemId: decodeURIComponent(knowledgeItem[2]),
      operationActor: 'human'
    }));
    return true;
  }
  if (url.pathname === '/api/subscriptions' && request.method === 'POST') {
    sendJson(response, 200, await app.subscribePublicProject(await readJson(request)));
    return true;
  }
  const subscription = url.pathname.match(/^\/api\/subscriptions\/([^/]+)$/);
  if (subscription && request.method === 'DELETE') {
    sendJson(response, 200, await app.unsubscribePublicProject({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      projectId: decodeURIComponent(subscription[1]),
      providerUrl: url.searchParams.get('providerUrl')
    }));
    return true;
  }
  if (url.pathname === '/api/personal-projects' && request.method === 'GET') {
    sendJson(response, 200, await app.listPersonalProjects({
      personalSpaceId: url.searchParams.get('personalSpaceId')
    }));
    return true;
  }
  if (url.pathname === '/api/personal-projects' && request.method === 'PUT') {
    sendJson(response, 200, await app.upsertPersonalProject(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/project-agents' && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectAgents({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      status: url.searchParams.get('status'),
      capability: url.searchParams.get('capability')
    }));
    return true;
  }
  if (url.pathname === '/api/project-agents' && request.method === 'PUT') {
    sendJson(response, 200, await app.upsertProjectAgent(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/project-agent-context' && request.method === 'POST') {
    sendJson(response, 200, await app.getProjectAgentContext(await readJson(request)));
    return true;
  }
  const projectAgentPath = url.pathname.match(/^\/api\/project-agents\/([^/]+)$/);
  if (projectAgentPath && request.method === 'GET') {
    sendJson(response, 200, await app.getProjectAgent({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      agentId: decodeURIComponent(projectAgentPath[1])
    }));
    return true;
  }
  if (projectAgentPath && request.method === 'DELETE') {
    sendJson(response, 200, await app.deleteProjectAgent({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      agentId: decodeURIComponent(projectAgentPath[1]),
      reason: url.searchParams.get('reason') ?? 'archived by user'
    }));
    return true;
  }
  if (url.pathname === '/api/project-agents/test-cleanup' && request.method === 'POST') {
    sendJson(response, 200, await app.cleanupProjectAgentTestRoles({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      testSource: url.searchParams.get('testSource')
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-assignments' && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectAgentAssignments({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      agentId: url.searchParams.get('agentId'),
      status: url.searchParams.get('status')
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-assignments' && request.method === 'POST') {
    sendJson(response, 200, await app.createProjectAgentAssignment(await readJson(request)));
    return true;
  }
  const projectAgentAssignmentPath = url.pathname.match(
    /^\/api\/project-agent-assignments\/([^/]+)\/(end|replace)$/
  );
  if (projectAgentAssignmentPath && request.method === 'POST') {
    const body = await readJson(request);
    const input = {
      ...body,
      assignmentId: decodeURIComponent(projectAgentAssignmentPath[1])
    };
    const result = projectAgentAssignmentPath[2] === 'end'
      ? await app.endProjectAgentAssignment(input)
      : await app.replaceProjectAgentAssignment(input);
    sendJson(response, 200, result);
    return true;
  }
  if (url.pathname === '/api/project-agent-tasks' && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectAgentTasks({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      agentId: url.searchParams.get('agentId'),
      status: url.searchParams.get('status'),
      limit: numberParam(url, 'limit', null)
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-tasks' && request.method === 'POST') {
    sendJson(response, 200, await app.submitProjectAgentTask(await readJson(request)));
    return true;
  }
  const projectAgentTaskPath = url.pathname.match(/^\/api\/project-agent-tasks\/([^/]+)$/);
  if (projectAgentTaskPath && request.method === 'GET') {
    sendJson(response, 200, await app.viewProjectAgentTask({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      taskId: decodeURIComponent(projectAgentTaskPath[1]),
      includeEvents: url.searchParams.get('includeEvents') !== 'false'
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-activity' && request.method === 'GET') {
    sendJson(response, 200, await app.viewProjectAgentActivity({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      agentId: url.searchParams.get('agentId'),
      fromDate: url.searchParams.get('fromDate'),
      toDate: url.searchParams.get('toDate')
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-activity' && request.method === 'POST') {
    sendJson(response, 200, await app.recordProjectAgentTaskActivity(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/project-agent-coordination-policy' && request.method === 'GET') {
    sendJson(response, 200, await app.getProjectAgentCoordinationPolicy({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId')
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-coordination-policy' &&
      (request.method === 'PUT' || request.method === 'PATCH')) {
    sendJson(response, 200, await app.updateProjectAgentCoordinationPolicy(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/project-agent-recruitment-policy' && request.method === 'GET') {
    sendJson(response, 200, await app.getProjectAgentRecruitmentPolicy({
      personalSpaceId: url.searchParams.get('personalSpaceId')
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-recruitment-policy' &&
      (request.method === 'PUT' || request.method === 'PATCH')) {
    sendJson(response, 200, await app.updateProjectAgentRecruitmentPolicy(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/project-agent-recruitments' && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectAgentRecruitments({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      taskId: url.searchParams.get('taskId'),
      status: url.searchParams.get('status')
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-recruitments/decision' && request.method === 'POST') {
    sendJson(response, 200, await app.decideProjectAgentRecruitment(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/executors' && request.method === 'GET') {
    sendJson(response, 200, await app.listExecutors({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      capability: url.searchParams.get('capability'),
      availableOnly: url.searchParams.get('availableOnly') === 'true'
    }));
    return true;
  }
  if (url.pathname === '/api/executors' && request.method === 'PUT') {
    sendJson(response, 200, await app.upsertExecutor(await readJson(request)));
    return true;
  }
  const executorPath = url.pathname.match(/^\/api\/executors\/([^/]+)$/);
  if (executorPath && request.method === 'GET') {
    sendJson(response, 200, await app.getExecutor({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      executorId: decodeURIComponent(executorPath[1])
    }));
    return true;
  }
  if (executorPath && request.method === 'DELETE') {
    sendJson(response, 200, await app.deleteExecutor({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      executorId: decodeURIComponent(executorPath[1])
    }));
    return true;
  }
  if (url.pathname === '/api/executors/preflight' && request.method === 'POST') {
    sendJson(response, 200, await app.preflightExecutor(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/executors/authorization' && request.method === 'POST') {
    sendJson(response, 200, await app.authorizeExecutor(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/executors/health' && request.method === 'POST') {
    sendJson(response, 200, await app.reportExecutorHealth(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/project-agent-executor-actuals' && request.method === 'POST') {
    sendJson(response, 200, await app.recordProjectAgentExecutorActual(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/executor-routing-rules' && request.method === 'GET') {
    sendJson(response, 200, await app.listExecutorRoutingRules({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      scope: url.searchParams.get('scope'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      taskId: url.searchParams.get('taskId'),
      status: url.searchParams.get('status')
    }));
    return true;
  }
  if (url.pathname === '/api/executor-routing-rules' && request.method === 'PUT') {
    sendJson(response, 200, await app.upsertExecutorRoutingRule(await readJson(request)));
    return true;
  }
  const executorRoutingRulePath = url.pathname.match(
    /^\/api\/executor-routing-rules\/([^/]+)$/
  );
  if (executorRoutingRulePath && request.method === 'GET') {
    sendJson(response, 200, await app.getExecutorRoutingRule({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      ruleId: decodeURIComponent(executorRoutingRulePath[1])
    }));
    return true;
  }
  if (executorRoutingRulePath && request.method === 'PATCH') {
    const body = await readJson(request);
    sendJson(response, 200, await app.updateExecutorRoutingRule({
      ...body,
      personalSpaceId: body.personalSpaceId ?? url.searchParams.get('personalSpaceId'),
      ruleId: decodeURIComponent(executorRoutingRulePath[1])
    }));
    return true;
  }
  if (executorRoutingRulePath && request.method === 'DELETE') {
    sendJson(response, 200, await app.deleteExecutorRoutingRule({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      ruleId: decodeURIComponent(executorRoutingRulePath[1])
    }));
    return true;
  }
  if (url.pathname === '/api/project-agent-routing-learning' && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectAgentRoutingLearning({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      workKind: url.searchParams.get('workKind'),
      agentId: url.searchParams.get('agentId'),
      executorId: url.searchParams.get('executorId')
    }));
    return true;
  }
  const projectAgentLearningPath = url.pathname.match(
    /^\/api\/project-agent-learning\/([^/]+)$/
  );
  if (projectAgentLearningPath && request.method === 'PATCH') {
    const body = await readJson(request);
    const evidenceId = decodeURIComponent(projectAgentLearningPath[1]);
    const action = body.action;
    if (!['ignore', 'reset'].includes(action)) {
      throw new TypeError('Project Agent learning action must be ignore or reset');
    }
    const personalSpaceId = body.personalSpaceId ??
      url.searchParams.get('personalSpaceId') ?? app.config?.personal?.spaceId;
    const personalProjectId = body.personalProjectId ??
      url.searchParams.get('personalProjectId');
    const agentId = body.agentId ?? url.searchParams.get('agentId');
    if (!personalSpaceId || !personalProjectId || !agentId) {
      throw new TypeError(
        'Project Agent learning updates require personalSpaceId, personalProjectId, and agentId'
      );
    }
    const idempotencyKey = body.idempotencyKey ??
      `console-learning:${evidenceId}:${action}`;
    const reason = body.reason ?? `Console requested ${action} for explicit evidence`;
    const input = {
      ...body,
      personalSpaceId,
      personalProjectId,
      agentId,
      evidenceId,
      idempotencyKey,
      reason
    };
    if (action === 'ignore') {
      sendJson(response, 200, await app.ignoreProjectAgentRoutingLearning(input));
      return true;
    }
    if (!input.workKind || !input.executorId || !input.resetAt) {
      throw new TypeError(
        'Project Agent learning reset requires workKind, executorId, and resetAt'
      );
    }
    sendJson(response, 200, await app.resetProjectAgentRoutingLearning(input));
    return true;
  }
  if (url.pathname === '/api/project-agent-routing-learning/ignore' && request.method === 'POST') {
    sendJson(response, 200, await app.ignoreProjectAgentRoutingLearning(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/project-agent-routing-learning/reset' && request.method === 'POST') {
    sendJson(response, 200, await app.resetProjectAgentRoutingLearning(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/project-agent-routing-outcomes' && request.method === 'POST') {
    sendJson(response, 200, await app.recordProjectAgentTaskOutcome(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/projects/publish' && request.method === 'POST') {
    sendJson(response, 200, await app.publishPersonalProject(await readJson(request)));
    return true;
  }
  const projectReleases = url.pathname.match(/^\/api\/projects\/([^/]+)\/releases$/);
  if (projectReleases && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectReleases({
      projectId: decodeURIComponent(projectReleases[1]),
      providerUrl: url.searchParams.get('providerUrl')
    }));
    return true;
  }
  const publicProject = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (publicProject && request.method === 'DELETE') {
    sendJson(response, 200, await app.deletePublicProject({
      projectId: decodeURIComponent(publicProject[1]),
      providerUrl: url.searchParams.get('providerUrl')
    }));
    return true;
  }
  if (url.pathname === '/api/project-relations' && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectRelations({
      projectId: url.searchParams.get('projectId'),
      providerUrl: url.searchParams.get('providerUrl')
    }));
    return true;
  }
  if (url.pathname === '/api/project-relations' && request.method === 'POST') {
    sendJson(response, 200, await app.createProjectRelation(await readJson(request)));
    return true;
  }
  const relationDecision = url.pathname.match(
    /^\/api\/project-relations\/([^/]+)\/decision$/
  );
  if (relationDecision && request.method === 'POST') {
    const body = await readJson(request);
    sendJson(response, 200, await app.reviewProjectRelation({
      ...body,
      relationId: decodeURIComponent(relationDecision[1])
    }));
    return true;
  }
  if (url.pathname === '/api/personal-review' && request.method === 'GET') {
    sendJson(response, 200, await app.listPersonalReviewQueue({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      status: url.searchParams.get('status') ?? 'pending'
    }));
    return true;
  }
  const personalDecision = url.pathname.match(/^\/api\/personal-review\/([^/]+)\/decision$/);
  if (personalDecision && request.method === 'POST') {
    const body = await readJson(request);
    sendJson(response, 200, await app.reviewPersonalDraft({
      ...body,
      draftId: decodeURIComponent(personalDecision[1])
    }));
    return true;
  }
  if (url.pathname === '/api/review' && request.method === 'GET') {
    sendJson(response, 200, await app.listReviewQueue({
      projectId: url.searchParams.get('projectId'),
      providerUrl: url.searchParams.get('providerUrl'),
      status: url.searchParams.get('status') ?? 'pending'
    }));
    return true;
  }
  const decision = url.pathname.match(/^\/api\/review\/([^/]+)\/decision$/);
  if (decision && request.method === 'POST') {
    const body = await readJson(request);
    sendJson(response, 200, await app.reviewProposal({
      ...body,
      proposalId: decodeURIComponent(decision[1])
    }));
    return true;
  }
  if (url.pathname === '/api/graphiti/status' && request.method === 'GET') {
    sendJson(response, 200, await app.getGraphitiStatus());
    return true;
  }
  return false;
}

function numberParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumberParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}
