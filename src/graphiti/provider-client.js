import { ApplicationError } from '../app/application-error.js';
import { activeAgentRequestSignal } from '../app/agent-request-context.js';
import { preferenceTaskSession } from './preference-task-scope.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const MAX_PROVIDER_VALIDATION_ERRORS = 5;
const KNOWLEDGE_TAG_ROUTES = new Set(['resolve', 'create', 'aliases', 'attach', 'detach', 'metrics']);

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
  #refreshAccessToken;

  constructor({
    baseUrl,
    accessToken,
    workflowObservationToken = null,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    refreshAccessToken = null
  }) {
    if (!baseUrl) throw new TypeError('Graphiti provider baseUrl is required');
    if (refreshAccessToken !== null && typeof refreshAccessToken !== 'function') {
      throw new TypeError('Graphiti provider token refresh must be a function');
    }
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
    this.#refreshAccessToken = refreshAccessToken;
  }

  agentVerification(operation, input) {
    if (!['query', 'record'].includes(operation)) throw new TypeError('Unknown verification operation');
    return this.#request(`/v1/agent-verification/${operation}`, { method: 'POST', body: input });
  }
  occupationDemand(input) {
    return this.#request('/v1/occupation-demand/query', { method: 'POST', body: input });
  }
  agentLoan(operation, input) {
    if (!['query', 'request', 'decide'].includes(operation)) throw new TypeError('Unknown loan operation');
    return this.#request(`/v1/agent-loans/${operation}`, { method: 'POST', body: input });
  }
  conversation(operation, input, { signal, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!['query', 'append', 'resume', 'policy', 'boundary'].includes(operation)) throw new TypeError('Unknown conversation operation');
    return this.#request(`/v1/agent-conversations/${operation}`, {
      method: operation === 'policy' ? 'PUT' : 'POST', body: input, signal, timeoutMs
    });
  }
  conversationTriage(operation, input) {
    if (!['record', 'topics', 'form'].includes(operation)) throw new TypeError('Unknown conversation triage operation');
    return this.#request(`/v1/conversation-triage/${operation}`, { method: 'POST', body: input });
  }
  currentTaskContext(input, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Current task timeout must be a positive safe integer');
    return this.#request(`/v1/task-context-sessions/current?${new URLSearchParams(input)}`,
      { timeoutMs: Math.min(timeoutMs, this.requestTimeoutMs), signal });
  }
  recordProjectMemoryUsage(input) {
    return this.#request('/v1/project-memory-usage', { method: 'POST', body: input });
  }
  readProjectMemoryUsage(personalSpaceId) {
    return this.#request(`/v1/project-memory-usage?${new URLSearchParams({ personal_space_id: personalSpaceId })}`);
  }
  getProjectAgentWorkerRun(runId, { personal_space_id, personal_project_id }, { capability, signal } = {}) {
    const query = new URLSearchParams({ personal_space_id, personal_project_id });
    return this.#workerRequest(`/v1/project-agent-worker-runs/${encodeURIComponent(runId)}?${query}`, { capability, signal });
  }
  prepareProjectAgentWorkerRun(input, { signal } = {}) {
    return this.#workerHostRequest('/v1/project-agent-worker-runs', { method: 'PUT', body: input, signal });
  }
  claimProjectAgentWorkerStart(runId, scope, { capability, signal } = {}) {
    return this.#workerRequest(`/v1/project-agent-worker-runs/${encodeURIComponent(runId)}/start-claim`, {
      capability, signal, method: 'POST', body: scope
    });
  }
  sealProjectAgentWorkerSession(runId, input, { capability, signal } = {}) {
    return this.#workerRequest(`/v1/project-agent-worker-runs/${encodeURIComponent(runId)}/session`, {
      capability, signal, method: 'PUT', body: input
    });
  }
  closeProjectAgentWorkerRun(runId, input, { capability, signal } = {}) {
    return this.#workerRequest(`/v1/project-agent-worker-runs/${encodeURIComponent(runId)}/close`, {
      capability, signal, method: 'POST', body: input
    });
  }
  dispatchProjectAgentWorkerPrompt(runId, input, { capability, signal } = {}) {
    return this.#workerRequest(`/v1/project-agent-worker-runs/${encodeURIComponent(runId)}/dispatch`, {
      capability, signal, method: 'POST', body: input
    });
  }
  recordProjectAgentWorkerResult(runId, input, { capability, signal } = {}) {
    return this.#workerRequest(`/v1/project-agent-worker-runs/${encodeURIComponent(runId)}/result`, {
      capability, signal, method: 'POST', body: input
    });
  }
  listProjectAgentTaskRuns({ personalSpaceId, personalProjectId, taskId, limit = 50, cursor }) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId, personal_project_id: personalProjectId,
      limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return this.#request(`/v1/project-agent-tasks/${encodeURIComponent(taskId)}/runs?${query}`);
  }
  revokeProjectAgentWorkerRun(runId, input, { signal } = {}) {
    return this.#workerHostRequest(`/v1/project-agent-worker-runs/${encodeURIComponent(runId)}/revoke`, {
      signal, method: 'POST', body: input
    });
  }
  admitProjectAgentWorkerContext(runId, { personal_space_id, personal_project_id, source_application, session_id }, { capability, signal } = {}) {
    return this.#workerRequest(`/v1/project-agent-worker-runs/${encodeURIComponent(runId)}/contexts`, {
      capability, signal, method: 'POST', body: { personal_space_id, personal_project_id, source_application, session_id }
    });
  }
  async #workerRequest(path, { capability, signal = activeAgentRequestSignal(), ...options } = {}) {
    if (typeof capability !== 'string' || capability.length < 32) {
      throw new TypeError('Worker runtime capability is required');
    }
    return this.#workerHostRequest(path, { ...options, signal, workerCapability: capability });
  }
  async #workerHostRequest(path, { signal = activeAgentRequestSignal(), ...options } = {}) {
    try {
      return await this.#request(path, { ...options, signal });
    } catch (error) {
      // A capability must never be reflected by Provider detail, abort reason or cause.
      const cancelled = signal?.aborted;
      const code = cancelled ? 'request_cancelled' : error instanceof ProviderRequestError ? error.code : 'provider_unavailable';
      const message = cancelled ? 'Worker runtime request was cancelled.'
        : code === 'provider_timeout' ? 'Worker runtime request timed out.' : 'Worker runtime request failed.';
      throw new ProviderRequestError(message, { code, status: cancelled ? 0 : error.status ?? 0 });
    }
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
  ensureTemporaryProject(input) {
    return this.#request('/v1/temporary-projects/ensure', { method: 'POST', body: input });
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
  listAgentAttention(input) {
    const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value != null));
    return this.#request(`/v1/agent-attention?${query}`);
  }
  changeAgentAttention(operation, input) {
    const paths = { create: '/v1/agent-attention', cancel: '/v1/agent-attention/cancel', respond: '/v1/agent-attention/respond' };
    if (!Object.hasOwn(paths, operation)) throw new TypeError('Unknown attention operation');
    return this.#request(paths[operation], { method: 'POST', body: input });
  }
  ensureSystemProjectHr(personalSpaceId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(`/v1/project-agents/system-hr?${query}`, { method: 'POST' });
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
  listProjectAgentPage(personalSpaceId, options = {}) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    for (const [key, value] of [['personal_project_id', options.personalProjectId], ['status', options.status],
      ['capability', options.capability], ['work', options.work], ['limit', options.limit], ['cursor', options.cursor]]) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    return this.#request(`/v1/project-agent-pages?${query}`);
  }
  getProjectAgent(personalSpaceId, personalProjectId, agentId) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    return this.#request(
      `/v1/project-agents/${encodeURIComponent(agentId)}?${query}`
    );
  }
  getProjectAgentMemory({ personalSpaceId, personalProjectId, agentId, limit = 1 }) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId, limit: String(limit)
    });
    if (personalProjectId !== null && personalProjectId !== undefined) query.set('personal_project_id', personalProjectId);
    return this.#request(`/v1/project-agents/${encodeURIComponent(agentId)}/memory?${query}`);
  }
  writeProjectAgentMemory(input) {
    return this.#request(`/v1/project-agents/${encodeURIComponent(input.agent_id)}/memory`, {
      method: 'PUT', body: input
    });
  }
  resolveProjectAgentContext(input) {
    return this.#request('/v1/project-agent-context/resolve', { method: 'POST', body: input });
  }
  issueAgentDelegation(input) {
    return this.#request('/v1/project-agent-context/delegations', { method: 'POST', body: input });
  }
  sealAgentDelegation(input) {
    return this.#request('/v1/project-agent-context/delegations/seal', { method: 'POST', body: input });
  }
  admitAgentDelegation(input) {
    return this.#request('/v1/project-agent-context/delegations/admit', { method: 'POST', body: input });
  }
  observeAgentDelegationMemory(input) {
    return this.#request('/v1/project-agent-context/delegations/memory-result', { method: 'POST', body: input });
  }
  issueRemoteAgentDelegation(input) {
    return this.#request('/v1/project-agent-context/remote-delegations', { method: 'POST', body: input });
  }
  issueRemoteAgentOrigin(input) {
    return this.#request('/v1/project-agent-context/remote-origins', { method: 'POST', body: input });
  }
  getRemoteOriginAuthority(personalSpaceId) {
    return this.#request(`/v1/project-agent-context/remote-origin-authority?${new URLSearchParams({ personal_space_id: personalSpaceId })}`);
  }
  verifyAgentDelegation(input) {
    return this.#request('/v1/project-agent-context/delegations/verify', { method: 'POST', body: input });
  }
  revokeAgentDelegation(input) {
    return this.#request('/v1/project-agent-context/delegations/revoke', { method: 'POST', body: input });
  }
  recentAgentSessions({ personalSpaceId, agentId, personalProjectId = null, limit = 5 }) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId, project_agent_id: agentId, limit: String(limit) });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    return this.#request(`/v1/task-context-sessions/recent?${query}`);
  }
  staffDefaultProjectLead(input) {
    return this.#request('/v1/project-agent-context/default-lead', { method: 'POST', body: input });
  }
  beginTaskContext(input) {
    return this.#request('/v1/task-contexts', { method: 'PUT', body: input });
  }
  adoptTaskContextAgent(token, input) {
    return this.#request(`/v1/task-contexts/${encodeURIComponent(token)}/agent`, {
      method: 'PUT', body: input
    });
  }
  bindTaskContextCoordinationTask(token, input) {
    return this.#request(`/v1/task-contexts/${encodeURIComponent(token)}/coordination-tasks`, {
      method: 'PUT', body: input
    });
  }
  getTaskContext(token, query, { signal } = {}) {
    return this.#request(`/v1/task-contexts/${encodeURIComponent(token)}?${new URLSearchParams(query)}`, { signal });
  }

  readTaskPreferences(token, input) {
    return this.#request(`/v1/task-contexts/${encodeURIComponent(token)}/preferences/read`,
      { method: 'POST', body: input });
  }
  checkpointTaskContext(token, input) {
    return this.#request(`/v1/task-contexts/${encodeURIComponent(token)}/checkpoint`, {
      method: 'PUT', body: input
    });
  }
  verifyTaskCheckpoint(query) {
    return this.#request(`/v1/task-context-sessions/checkpoint?${new URLSearchParams(query)}`);
  }
  updateProjectAgentOccupation(agentId, input) {
    return this.#request(`/v1/project-agents/${encodeURIComponent(agentId)}/occupation`, {
      method: 'PUT', body: input
    });
  }
  occupationCatalog(operation, input) {
    const { key, ...body } = input;
    const methods = { list: 'GET', create: 'POST', update: 'PUT', archive: 'POST', delete: 'DELETE' };
    if (!Object.hasOwn(methods, operation)) throw new TypeError('Unknown occupation operation');
    const item = ['update', 'archive', 'delete'].includes(operation);
    if (item && (typeof key !== 'string' || !key)) throw new TypeError('Occupation key is required');
    const path = '/v1/occupations' + (item ? `/${encodeURIComponent(key)}` : '')
      + (operation === 'archive' ? '/archive' : '');
    return operation === 'list'
      ? this.#request(`${path}?${new URLSearchParams(body)}`)
      : this.#request(path, { method: methods[operation], body });
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
  // The task a submit with this idempotency key created, or { task: null }.
  findProjectAgentTaskByIdempotencyKey({ personalSpaceId, personalProjectId, idempotencyKey }) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId,
      personal_project_id: personalProjectId, idempotency_key: idempotencyKey });
    return this.#request(`/v1/project-agent-task-lookup?${query}`);
  }
  viewProjectAgentTask(personalSpaceId, taskId, {
    personalProjectId = null,
    includeEvents = true
  } = {}) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    query.set('include_events', String(includeEvents));
    return this.#request(
      `/v1/project-agent-tasks/${encodeURIComponent(taskId)}?${query}`
    );
  }
  recordProjectAgentTaskActivity(input, { signal } = {}) {
    return this.#request(
      `/v1/project-agent-tasks/${encodeURIComponent(input.task_id ?? input.taskId)}/events`,
      {
        method: 'POST', body: input, signal
      }
    );
  }
  openProjectAgentTaskEvents(personalSpaceId, { signal } = {}) {
    const query = new URLSearchParams({ personal_space_id: personalSpaceId });
    return this.#request(`/v1/project-agent-task-events?${query}`, { stream: true, signal });
  }
  listProjectAgentActivity({
    personalSpaceId,
    personalProjectId = null,
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
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
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
  // The open tag vocabulary; reads are POST queries like the other Provider queries.
  knowledgeTags(route, input) {
    if (!KNOWLEDGE_TAG_ROUTES.has(route)) throw new TypeError('Unknown knowledge tag route');
    return this.#request(`/v1/knowledge-tags/${route}`, { method: 'POST', body: input });
  }
  // Reads sent as POST: the host supplies the review verdicts it keeps locally.
  getProjectAgentScoreCard(query) {
    return this.#request('/v1/project-agent-score-card/query', { method: 'POST', body: query });
  }
  listProjectAgentScoreEvidence(query) {
    return this.#request('/v1/project-agent-score-card/evidence', { method: 'POST', body: query });
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
  preflightCommits(inputs) {
    return this.#request('/v1/knowledge/commits/preflight', { method: 'POST', body: inputs });
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
  listPreferenceConflicts(personalSpaceId, status = null, limit = 500, offset = 0) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      limit: String(limit)
    });
    if (status) query.set('status', status);
    if (offset) query.set('offset', String(offset));
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
    projectAgentId = null,
    taskScope = {}
  ) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      limit: String(limit)
    });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (projectAgentId) query.set('project_agent_id', projectAgentId);
    for (const [key, value] of Object.entries({ session_id: preferenceTaskSession(taskScope),
      work_kind: taskScope.workKind, workflow: taskScope.workflow })) {
      if (value) query.set(key, value);
    }
    return this.#request(`/v1/collaboration-preferences?${query}`);
  }
  graph(spaceId, limit = 500, personalProjectId = null, offset = null) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    if (offset !== null) query.set('offset', String(offset));
    return this.#request(`/v1/spaces/${encodeURIComponent(spaceId)}/graph?${query}`);
  }

  // A long-running client (an MCP server) outlives a token rotation, for
  // example after a graph import or a runtime mode switch. A rejected token is
  // replaced once by the current one and the request repeated; the Provider
  // did not act on the rejected request. An unchanged token is not retried.
  async #request(path, options = {}) {
    const used = this.accessToken;
    try {
      return await this.#send(path, options);
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.status !== 401
          || options.authenticated === false || !this.#refreshAccessToken) throw error;
      const current = await Promise.resolve().then(() => this.#refreshAccessToken()).catch(() => null);
      if (typeof current !== 'string' || !current || current === used) throw error;
      this.accessToken = current;
      return this.#send(path, options);
    }
  }

  async #send(path, {
    method = 'GET',
    body,
    authenticated = true,
    workflowObservation = false,
    workerCapability = null,
    stream = false,
    signal: requestSignal = activeAgentRequestSignal(),
    timeoutMs = this.requestTimeoutMs
  } = {}) {
    const headers = { accept: stream ? 'text/event-stream' : 'application/json' };
    if (authenticated) headers.authorization = `Bearer ${this.accessToken}`;
    if (workflowObservation) {
      headers['x-fuli-workflow-observation-token'] = this.#workflowObservationToken;
    }
    if (workerCapability !== null) headers['x-fuli-worker-capability'] = workerCapability;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Graphiti provider request timed out'));
    }, timeoutMs);
    const callerSignal = requestSignal;
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    let response;
    let payload;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
      if (!stream || !response.ok) payload = await parseResponse(response);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (!timedOut && callerSignal?.aborted) {
        throw callerSignal.reason ?? new DOMException('Aborted', 'AbortError');
      }
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
    if (stream && !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw invalidResponse('Graphiti provider did not return a task event stream.');
    }
    return stream ? response : payload;
  }
}

async function parseResponse(response) {
  const type = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!type.includes('application/json')) {
    if (!response.ok) return text ? { detail: text } : null;
    throw invalidResponse(
      text ? 'Graphiti provider returned a non-JSON response.'
        : 'Graphiti provider returned an empty response.'
    );
  }
  if (!text.trim()) {
    if (!response.ok) return null;
    throw invalidResponse('Graphiti provider returned an empty response.');
  }
  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) return null;
    throw invalidResponse('Graphiti provider returned invalid JSON.');
  }
}

function invalidResponse(message) {
  return new ProviderRequestError(message, { code: 'provider_invalid_response' });
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
    category: typeof payload?.detail?.code === 'string' && /^[a-z][a-z0-9_]{1,79}$/.test(payload.detail.code)
      ? payload.detail.code : category,
    status,
    detail: sanitizeProviderDetail(providerErrorMessage(payload, validationErrors)),
    validationErrors
  };
}

function providerErrorMessage(payload, validationErrors = providerValidationErrors(payload)) {
  if (typeof payload?.detail === 'string') return payload.detail;
  if (typeof payload?.detail?.message === 'string') return payload.detail.message;
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
