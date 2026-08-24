import { ApplicationError } from '../app/application-error.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const MAX_PROVIDER_VALIDATION_ERRORS = 5;

export class ProviderRequestError extends ApplicationError {
  constructor(message, {
    status = 0,
    code = 'provider_error',
    details = null,
    diagnostic = null,
    validationErrors = []
  } = {}) {
    super(code, message);
    this.name = 'ProviderRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.diagnostic = diagnostic;
    this.validationErrors = Array.isArray(validationErrors)
      ? validationErrors.slice(0, MAX_PROVIDER_VALIDATION_ERRORS)
      : [];
  }
}

export class GraphitiProviderClient {
  #workflowObservationToken;

  constructor({
    baseUrl,
    accessToken,
    workflowObservationToken = null,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  }) {
    if (!baseUrl) throw new TypeError('Graphiti provider baseUrl is required');
    if (!accessToken) throw new TypeError('Graphiti provider accessToken is required');
    if (workflowObservationToken !== null && (
      typeof workflowObservationToken !== 'string' ||
      workflowObservationToken.trim().length < 32
    )) {
      throw new TypeError(
        'MCP host workflow observation credential must contain at least 32 characters'
      );
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    if (!Number.isSafeInteger(requestTimeoutMs) ||
        requestTimeoutMs < 1 ||
        requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new TypeError('Graphiti provider timeout must be a positive safe integer');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
    this.#workflowObservationToken = workflowObservationToken?.trim() ?? null;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  health() { return this.#request('/health', { authenticated: false }); }
  listSpaces() { return this.#request('/v1/spaces'); }
  createSpace(input) { return this.#request('/v1/spaces', { method: 'POST', body: input }); }
  listProjectReleases(projectId) {
    return this.#request(`/v1/projects/${encodeURIComponent(projectId)}/releases`);
  }
  deleteProject(projectId) {
    return this.#request(`/v1/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  }
  upsertPersonalProject(input) {
    return this.#request('/v1/personal-projects', { method: 'PUT', body: input });
  }
  listPersonalProjects(personalSpaceId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(`/v1/personal-projects?${query}`);
  }
  getPersonalProject(personalSpaceId, projectId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(
      `/v1/personal-projects/${encodeURIComponent(projectId)}?${query}`
    );
  }
  upsertProjectAgent(input) {
    return this.#request('/v1/project-agents', { method: 'PUT', body: input });
  }
  listProjectAgents(
    personalSpaceId,
    personalProjectId = null,
    { status = null, capability = null } = {}
  ) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId
    });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (status) query.set('status', status);
    if (capability) query.set('capability', capability);
    return this.#request(`/v1/project-agents?${query}`);
  }
  getProjectAgent(personalSpaceId, personalProjectId, agentId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    return this.#request(
      `/v1/project-agents/${encodeURIComponent(agentId)}?${query}`
    );
  }
  deleteProjectAgent(personalSpaceId, agentId, reason = 'archived by user') {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      reason
    });
    return this.#request(
      `/v1/project-agents/${encodeURIComponent(agentId)}?${query}`,
      { method: 'DELETE' }
    );
  }
  cleanupProjectAgentTestRoles(personalSpaceId, testSource) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      test_source: testSource
    });
    return this.#request(`/v1/project-agents/test-cleanup?${query}`, {
      method: 'POST'
    });
  }
  createProjectAgentAssignment(input) {
    return this.#request('/v1/project-agent-assignments', {
      method: 'POST', body: input
    });
  }
  listProjectAgentAssignments({
    personalSpaceId,
    personalProjectId = null,
    agentId = null,
    status = null
  }) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (agentId) query.set('agent_id', agentId);
    if (status) query.set('status', status);
    return this.#request(`/v1/project-agent-assignments?${query}`);
  }
  endProjectAgentAssignment(input) {
    return this.#request('/v1/project-agent-assignments/end', {
      method: 'POST', body: input
    });
  }
  replaceProjectAgentAssignment(input) {
    return this.#request('/v1/project-agent-assignments/replace', {
      method: 'POST', body: input
    });
  }
  submitProjectAgentTask(input) {
    return this.#request('/v1/project-agent-tasks', {
      method: 'POST', body: input
    });
  }
  listProjectAgentTasks({
    personalSpaceId,
    personalProjectId = null,
    agentId = null,
    status = null,
    limit = null
  }) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId
    });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (agentId) query.set('agent_id', agentId);
    if (status) query.set('status', status);
    if (limit !== null && limit !== undefined) query.set('limit', String(limit));
    return this.#request(`/v1/project-agent-tasks?${query}`);
  }
  viewProjectAgentTask(personalSpaceId, taskId, { includeEvents = true } = {}) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    query.set('include_events', String(includeEvents));
    return this.#request(
      `/v1/project-agent-tasks/${encodeURIComponent(taskId)}?${query}`
    );
  }
  recordProjectAgentTaskActivity(input) {
    return this.#request(
      `/v1/project-agent-tasks/${encodeURIComponent(input.task_id ?? input.taskId)}/events`,
      {
        method: 'POST', body: input
      }
    );
  }
  listProjectAgentActivity({
    personalSpaceId,
    agentId,
    fromDate = null,
    toDate = null
  }) {
    const today = new Date().toISOString().slice(0, 10);
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      from: fromDate ?? toDate ?? today,
      to: toDate ?? fromDate ?? today
    });
    return this.#request(
      `/v1/project-agents/${encodeURIComponent(agentId)}/activity?${query}`
    );
  }
  getProjectAgentCoordinationPolicy(personalSpaceId, personalProjectId) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      personal_project_id: personalProjectId
    });
    return this.#request(`/v1/project-agent-coordination-policy?${query}`);
  }
  updateProjectAgentCoordinationPolicy(input) {
    return this.#request('/v1/project-agent-coordination-policy', {
      method: 'PUT', body: input
    });
  }
  getProjectAgentRecruitmentPolicy(personalSpaceId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(`/v1/project-agent-recruitment-policy?${query}`);
  }
  updateProjectAgentRecruitmentPolicy(input) {
    return this.#request('/v1/project-agent-recruitment-policy', {
      method: 'PUT', body: input
    });
  }
  listProjectAgentRecruitments({
    personalSpaceId,
    personalProjectId = null,
    taskId = null,
    status = null
  }) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (taskId) query.set('task_id', taskId);
    if (status) query.set('status', status);
    return this.#request(`/v1/project-agent-recruitments?${query}`);
  }
  decideProjectAgentRecruitment(input) {
    return this.#request(
      `/v1/project-agent-recruitments/${encodeURIComponent(
        input.recruitment_id ?? input.recruitmentId
      )}/decision`,
      { method: 'POST', body: input }
    );
  }
  upsertExecutor(input) {
    return this.#request('/v1/executors', { method: 'PUT', body: input });
  }
  listExecutors(
    personalSpaceId,
    { capability = null, availableOnly = false } = {}
  ) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    if (capability) query.set('capability', capability);
    if (availableOnly) query.set('available_only', 'true');
    return this.#request(`/v1/executors?${query}`);
  }
  getExecutor(personalSpaceId, executorId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(`/v1/executors/${encodeURIComponent(executorId)}?${query}`);
  }
  deleteExecutor(personalSpaceId, executorId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(`/v1/executors/${encodeURIComponent(executorId)}?${query}`, {
      method: 'DELETE'
    });
  }
  preflightExecutor(input) {
    return this.#request('/v1/executors/preflight', { method: 'POST', body: input });
  }
  authorizeExecutor(input) {
    return this.#request('/v1/executors/authorization', {
      method: 'POST', body: input
    });
  }
  reportExecutorHealth(input) {
    return this.#request('/v1/executors/health', {
      method: 'POST', body: input
    });
  }
  recordProjectAgentExecutorActual(input) {
    return this.#request('/v1/project-agent-executor-actuals', {
      method: 'POST', body: input
    });
  }
  upsertExecutorRoutingRule(input) {
    return this.#request('/v1/executor-routing-rules', {
      method: 'PUT', body: input
    });
  }
  updateExecutorRoutingRule(input) {
    return this.#request(
      `/v1/executor-routing-rules/${encodeURIComponent(
        input.rule_id ?? input.ruleId
      )}`,
      { method: 'PATCH', body: input }
    );
  }
  listExecutorRoutingRules({
    personalSpaceId,
    scope = null,
    personalProjectId = null,
    taskId = null,
    status = null,
    enabled = null
  }) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    if (scope) query.set('scope', scope);
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (taskId) query.set('task_id', taskId);
    if (status) query.set('status', status);
    else if (enabled !== null && enabled !== undefined) {
      query.set('status', enabled ? 'active' : 'disabled');
    }
    return this.#request(`/v1/executor-routing-rules?${query}`);
  }
  getExecutorRoutingRule(personalSpaceId, ruleId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(
      `/v1/executor-routing-rules/${encodeURIComponent(ruleId)}?${query}`
    );
  }
  deleteExecutorRoutingRule(personalSpaceId, ruleId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(
      `/v1/executor-routing-rules/${encodeURIComponent(ruleId)}?${query}`,
      { method: 'DELETE' }
    );
  }
  recordProjectAgentTaskOutcome(input) {
    return this.#request('/v1/project-agent-routing-outcomes', {
      method: 'POST', body: input
    });
  }
  listProjectAgentRoutingLearning({
    personalSpaceId,
    personalProjectId = null,
    workKind = null,
    agentId = null,
    executorId = null
  }) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (workKind) query.set('work_kind', workKind);
    if (agentId) query.set('agent_id', agentId);
    if (executorId) query.set('executor_id', executorId);
    return this.#request(`/v1/project-agent-routing-learning?${query}`);
  }
  ignoreProjectAgentRoutingLearning(input) {
    return this.#request('/v1/project-agent-routing-learning/ignore', {
      method: 'POST', body: input
    });
  }
  resetProjectAgentRoutingLearning(input) {
    return this.#request('/v1/project-agent-routing-learning/reset', {
      method: 'POST', body: input
    });
  }
  createPublicationDraft(input) {
    return this.#request('/v1/publication-drafts', { method: 'POST', body: input });
  }
  listPublicationDrafts(personalSpaceId, status = 'pending') {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId, status });
    return this.#request(`/v1/publication-drafts?${query}`);
  }
  getPublicationDraft(personalSpaceId, draftId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(
      `/v1/publication-drafts/${encodeURIComponent(draftId)}?${query}`
    );
  }
  decidePublicationDraft(personalSpaceId, draftId, input) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(
      `/v1/publication-drafts/${encodeURIComponent(draftId)}/decision?${query}`,
      { method: 'POST', body: input }
    );
  }
  createPrincipal(input) {
    return this.#request('/v1/principals', { method: 'POST', body: input });
  }
  addMember(projectId, input) {
    return this.#request(`/v1/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST', body: input
    });
  }
  createProjectRelation(projectId, input) {
    return this.#request(`/v1/projects/${encodeURIComponent(projectId)}/relations`, {
      method: 'POST', body: input
    });
  }
  listProjectRelations(projectId) {
    return this.#request(`/v1/projects/${encodeURIComponent(projectId)}/relations`);
  }
  decideProjectRelation(projectId, relationId, input) {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/relations/` +
      `${encodeURIComponent(relationId)}/decision`,
      { method: 'POST', body: input }
    );
  }
  subscribe(input) {
    return this.#request('/v1/subscriptions', { method: 'POST', body: input });
  }
  listSubscriptions(personalSpaceId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(`/v1/subscriptions?${query}`);
  }
  unsubscribe(personalSpaceId, projectId, providerUrl) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      provider_url: providerUrl
    });
    return this.#request(`/v1/subscriptions/${encodeURIComponent(projectId)}?${query}`, {
      method: 'DELETE'
    });
  }
  commit(input) {
    return this.#request('/v1/knowledge/commits', { method: 'POST', body: input });
  }
  recordWorkflowObservation(input) {
    if (!this.#workflowObservationToken) {
      throw new TypeError('MCP host workflow observation credential is not configured');
    }
    return this.#request('/v1/workflow-observations', {
      method: 'POST', body: input, workflowObservation: true
    });
  }
  startKnowledgeReview(input) {
    return this.#request('/v1/knowledge/reviews/start', {
      method: 'POST', body: input
    });
  }
  listKnowledgeReviewCandidates(input) {
    return this.#request('/v1/knowledge/reviews/candidates', {
      method: 'POST', body: input
    });
  }
  recordKnowledgeReviewProgress(input) {
    return this.#request('/v1/knowledge/reviews/progress', {
      method: 'POST', body: input
    });
  }
  finishKnowledgeReview(input) {
    return this.#request('/v1/knowledge/reviews/finish', {
      method: 'POST', body: input
    });
  }
  searchWorkflowCandidates(input) {
    return this.#request('/v1/workflow-candidates/search', {
      method: 'POST', body: input
    });
  }
  recommendWorkflowCandidates(input) {
    return this.#request('/v1/workflow-candidates/recommendations', {
      method: 'POST', body: input
    });
  }
  reviseKnowledgeItem(itemId, input) {
    return this.#request(`/v1/knowledge/items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH', body: input
    });
  }
  recordAgentViews(input) {
    return this.#request('/v1/knowledge/agent-views', {
      method: 'POST', body: input
    });
  }
  recordKnowledgeUsage(input) {
    return this.#request('/v1/knowledge/usage', {
      method: 'POST', body: input
    });
  }
  recordKnowledgeFeedback(input) {
    return this.#request('/v1/knowledge/feedback', {
      method: 'POST', body: input
    });
  }
  reviewHumanChange(itemId, input) {
    return this.#request(
      `/v1/knowledge/items/${encodeURIComponent(itemId)}/agent-review`,
      { method: 'POST', body: input }
    );
  }
  searchHumanChanges(input) {
    return this.#request('/v1/knowledge/human-changes/search', {
      method: 'POST', body: input
    });
  }
  confirmKnowledgeBatch(input) {
    return this.#request('/v1/knowledge/batch-confirmations', {
      method: 'POST', body: input
    });
  }
  reassignKnowledgeItem(itemId, input) {
    return this.#request(
      `/v1/knowledge/items/${encodeURIComponent(itemId)}/assignment`,
      { method: 'POST', body: input }
    );
  }
  setPreferenceScope(itemId, input) {
    return this.#request(
      `/v1/knowledge/items/${encodeURIComponent(itemId)}/preference-scope`,
      { method: 'POST', body: input }
    );
  }
  previewCommonKnowledgePromotion(input) {
    return this.#request('/v1/knowledge/common-promotions/preview', {
      method: 'POST', body: input
    });
  }
  applyCommonKnowledgePromotion(input) {
    return this.#request('/v1/knowledge/common-promotions', {
      method: 'POST', body: input
    });
  }
  personalGlobalPreferenceDecisionStatus(input) {
    return this.#request(
      '/v1/personal-global-preference-candidates/decision-status',
      { method: 'POST', body: input }
    );
  }
  personalGlobalPreferenceScopeOptions(candidateId, input) {
    return this.#request(
      '/v1/personal-global-preference-candidates/' +
      `${encodeURIComponent(candidateId)}/scope-options`,
      { method: 'POST', body: input }
    );
  }
  inspectPersonalGlobalPreferenceDecision(candidateId, input) {
    return this.#request(
      '/v1/personal-global-preference-candidates/' +
      `${encodeURIComponent(candidateId)}/decision-inspection`,
      { method: 'POST', body: input }
    );
  }
  applyPersonalGlobalPreferenceDecision(candidateId, input) {
    return this.#request(
      '/v1/personal-global-preference-candidates/' +
      `${encodeURIComponent(candidateId)}/decision`,
      { method: 'POST', body: input }
    );
  }
  deferPreferenceConflict(input) {
    return this.#request('/v1/preference-conflicts/defer', {
      method: 'POST', body: input
    });
  }
  listPreferenceConflicts(personalSpaceId, status = null, limit = 500) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      limit: String(limit)
    });
    if (status) query.set('status', status);
    return this.#request(`/v1/preference-conflicts?${query}`);
  }
  resolvePreferenceConflict(conflictId, input) {
    return this.#request(
      `/v1/preference-conflicts/${encodeURIComponent(conflictId)}/resolve`,
      { method: 'POST', body: input }
    );
  }
  completePreferenceConflict(conflictId, input) {
    return this.#request(
      `/v1/preference-conflicts/${encodeURIComponent(conflictId)}/complete`,
      { method: 'POST', body: input }
    );
  }
  previewKnowledgeProjectAction(itemId, input) {
    return this.#request(
      `/v1/knowledge/items/${encodeURIComponent(itemId)}/project-action/preview`,
      { method: 'POST', body: input }
    );
  }
  applyKnowledgeProjectAction(itemId, input) {
    return this.#request(
      `/v1/knowledge/items/${encodeURIComponent(itemId)}/project-action`,
      { method: 'POST', body: input }
    );
  }
  createProposal(projectId, input) {
    return this.#request(`/v1/projects/${encodeURIComponent(projectId)}/proposals`, {
      method: 'POST', body: input
    });
  }
  listProposals(projectId, status = 'pending') {
    const query = new URLSearchParams({ status });
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/proposals?${query}`
    );
  }
  decideProposal(projectId, proposalId, input) {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/proposals/` +
      `${encodeURIComponent(proposalId)}/decision`,
      { method: 'POST', body: input }
    );
  }
  search(input) { return this.#request('/v1/search', { method: 'POST', body: input }); }
  collaborationPreferences(
    personalSpaceId,
    personalProjectId = null,
    limit = 100,
    projectAgentId = null
  ) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      limit: String(limit)
    });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (projectAgentId) query.set('project_agent_id', projectAgentId);
    return this.#request(`/v1/collaboration-preferences?${query}`);
  }
  graph(spaceId, limit = 500, personalProjectId = null, offset = null) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (offset !== null) query.set('offset', String(offset));
    return this.#request(`/v1/spaces/${encodeURIComponent(spaceId)}/graph?${query}`);
  }

  async #request(path, {
    method = 'GET',
    body,
    authenticated = true,
    workflowObservation = false
  } = {}) {
    const headers = { accept: 'application/json' };
    if (authenticated) headers.authorization = `Bearer ${this.accessToken}`;
    if (workflowObservation) {
      headers['x-fuli-workflow-observation-token'] = this.#workflowObservationToken;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Graphiti provider request timed out'));
    }, this.requestTimeoutMs);
    const { signal } = controller;
    let response;
    let payload;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
      payload = await parseResponse(response);
    } catch (error) {
      const diagnostic = {
        category: timedOut ? 'provider_timeout' : 'provider_unavailable',
        status: timedOut ? 504 : 0,
        detail: timedOut
          ? 'Graphiti provider request timed out.'
          : 'Graphiti provider is unavailable.'
      };
      throw new ProviderRequestError(
        diagnostic.detail,
        {
          status: diagnostic.status,
          code: diagnostic.category,
          details: timedOut ? null : diagnostic,
          diagnostic
        }
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const diagnostic = providerErrorDiagnostic(response.status, payload);
      throw new ProviderRequestError(
        diagnostic.detail,
        {
          status: response.status,
          code: diagnostic.category,
          details: diagnostic,
          diagnostic,
          validationErrors: diagnostic.validationErrors
        }
      );
    }
    return payload;
  }
}

async function parseResponse(response) {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return response.json();
  const text = await response.text();
  return text ? { detail: text } : null;
}

function providerErrorDiagnostic(status, payload) {
  const category = status >= 500 && status <= 599
    ? 'provider_http_5xx'
    : 'provider_error';
  if (category === 'provider_http_5xx') {
    return {
      category,
      status,
      detail: `Graphiti provider returned HTTP ${status}.`
    };
  }
  const validationErrors = providerValidationErrors(payload);
  return {
    category,
    status,
    detail: sanitizeProviderDetail(providerErrorMessage(payload, validationErrors)),
    validationErrors
  };
}

function providerErrorMessage(payload, validationErrors = providerValidationErrors(payload)) {
  if (typeof payload?.detail === 'string') return payload.detail;
  if (!validationErrors.length) return 'Graphiti provider request failed';
  const messages = validationErrors.map(({ field, message }) => (
    field ? `${field} — ${message}` : message
  ));
  return `Graphiti provider rejected the request — ${messages.join('; ')}`;
}

function sanitizeProviderDetail(value) {
  return String(value ?? 'Graphiti provider request failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s"']+/g, '<path>')
    .replace(/https?:\/\/[^\s"']+/gi, '<url>')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll(':', ' —')
    .slice(0, 320) || 'Graphiti provider request failed';
}

// Issue source: WZ.
// Provider validation failures must expose the field and actionable reason
// without echoing FastAPI's submitted input payload.
function providerValidationErrors(payload) {
  if (!Array.isArray(payload?.detail)) return [];
  return payload.detail
    .filter((item) => item && typeof item.msg === 'string' && item.msg.trim())
    .slice(0, MAX_PROVIDER_VALIDATION_ERRORS)
    .map((item) => ({
      field: validationLocation(item.loc),
      message: sanitizeProviderDetail(item.msg.trim())
    }));
}

function validationLocation(loc) {
  if (!Array.isArray(loc)) return '';
  return loc
    .filter((segment) => segment !== 'body')
    .reduce((path, segment) => {
      if (typeof segment === 'number') return `${path}[${segment}]`;
      if (typeof segment !== 'string' || !segment) return path;
      return path ? `${path}.${segment}` : segment;
    }, '');
}
