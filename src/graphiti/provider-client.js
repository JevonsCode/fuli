import { ApplicationError } from '../app/application-error.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

export class ProviderRequestError extends ApplicationError {
  constructor(message, { status = 0, code = 'provider_error', details = null } = {}) {
    super(code, message);
    this.name = 'ProviderRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class GraphitiProviderClient {
  constructor({
    baseUrl,
    accessToken,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  }) {
    if (!baseUrl) throw new TypeError('Graphiti provider baseUrl is required');
    if (!accessToken) throw new TypeError('Graphiti provider accessToken is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    if (!Number.isSafeInteger(requestTimeoutMs) ||
        requestTimeoutMs < 1 ||
        requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new TypeError('Graphiti provider timeout must be a positive safe integer');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
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
  collaborationPreferences(personalSpaceId, personalProjectId = null, limit = 100) {
    const query = new URLSearchParams({
      personal_space_id: personalSpaceId,
      limit: String(limit)
    });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    return this.#request(`/v1/collaboration-preferences?${query}`);
  }
  graph(spaceId, limit = 500, personalProjectId = null) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (personalProjectId) query.set('personal_project_id', personalProjectId);
    return this.#request(`/v1/spaces/${encodeURIComponent(spaceId)}/graph?${query}`);
  }

  async #request(path, {
    method = 'GET',
    body,
    authenticated = true
  } = {}) {
    const headers = { accept: 'application/json' };
    if (authenticated) headers.authorization = `Bearer ${this.accessToken}`;
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
      throw new ProviderRequestError(
        timedOut
          ? 'Graphiti provider request timed out'
          : 'Graphiti provider is unavailable',
        {
          status: timedOut ? 504 : 0,
          code: timedOut ? 'provider_timeout' : 'provider_unavailable',
          details: timedOut ? null : error instanceof Error ? error.message : null
        }
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new ProviderRequestError(
        typeof payload?.detail === 'string' ? payload.detail : 'Graphiti provider request failed',
        { status: response.status, details: payload }
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
