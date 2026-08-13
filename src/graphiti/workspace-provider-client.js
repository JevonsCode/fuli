import { createHash } from 'node:crypto';

import {
  GraphitiProviderClient,
  ProviderRequestError
} from './provider-client.js';
import { canonicalProviderUrl } from './runtime-config.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const MAX_LIST_PAGES = 100;
const FULI_WORKSPACE_PROTOCOL = 'fuli-workspace-v1';
const GRAPHITI_PROTOCOL = 'graphiti-v1';

const GRAPHITI_CAPABILITIES = Object.freeze({
  browsePublicProjects: true,
  publishProject: true,
  submitKnowledge: true,
  subscribeProject: true,
  reviewProposals: true,
  query: true
});

export const FULI_WORKSPACE_CAPABILITIES = Object.freeze({
  browsePublicProjects: true,
  publishProject: false,
  submitKnowledge: false,
  subscribeProject: true,
  reviewProposals: false,
  query: true
});

export function createWorkspaceProvider(workspace, {
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
} = {}) {
  const providerUrl = canonicalProviderUrl(workspace.providerUrl);
  const protocol = workspace.protocol ?? GRAPHITI_PROTOCOL;
  const fuliWorkspace = protocol === FULI_WORKSPACE_PROTOCOL;
  const client = fuliWorkspace
    ? new FuliWorkspaceProviderClient({
      baseUrl: providerUrl,
      accessToken: workspace.accessToken,
      fetchImpl,
      requestTimeoutMs
    })
    : new GraphitiProviderClient({
      baseUrl: providerUrl,
      accessToken: workspace.accessToken,
      fetchImpl,
      requestTimeoutMs
    });
  return {
    ...workspace,
    providerUrl,
    protocol,
    capabilities: fuliWorkspace ? FULI_WORKSPACE_CAPABILITIES : GRAPHITI_CAPABILITIES,
    client
  };
}

export function aggregatePublicCapabilities(workspaces, providerStatuses, projects) {
  const ready = new Set(providerStatuses
    .filter(({ status }) => status === 'ready')
    .map(({ providerUrl }) => providerUrl));
  const supports = (capability) => [...workspaces.values()].some((workspace) =>
    ready.has(workspace.providerUrl) && workspace.capabilities[capability] === true
  );
  return {
    browsePublicProjects: supports('browsePublicProjects'),
    publishProject: supports('publishProject'),
    submitKnowledge: supports('submitKnowledge'),
    subscribeProject: supports('subscribeProject'),
    reviewProposals: supports('reviewProposals') &&
      projects.some(({ role }) => role === 'maintainer')
  };
}

export class FuliWorkspaceProviderClient {
  #accessToken;
  #fetch;

  constructor({
    baseUrl,
    accessToken,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  }) {
    if (!baseUrl) throw new TypeError('Fuli Workspace provider baseUrl is required');
    if (!accessToken) throw new TypeError('Fuli Workspace provider accessToken is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
        requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new TypeError('Fuli Workspace provider timeout must be a positive safe integer');
    }
    this.baseUrl = canonicalProviderUrl(baseUrl);
    this.#accessToken = accessToken;
    this.#fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async health() {
    const [payload, session] = await Promise.all([
      this.#request('/healthz', { authenticated: false }),
      this.#request('/v1/auth/session')
    ]);
    if (payload?.status !== 'ok' || String(payload?.protocolVersion) !== '1') {
      throw invalidResponse('Fuli Workspace health response is incompatible');
    }
    if (session?.authenticated !== true) {
      throw invalidResponse('Fuli Workspace authentication session is invalid');
    }
    return {
      status: 'ready',
      providerId: 'fuli-workspace',
      mode: 'workspace',
      storage: 'sqlite',
      protocol: FULI_WORKSPACE_PROTOCOL,
      protocolVersion: '1'
    };
  }

  async listSpaces() {
    const workspaces = [];
    let cursor = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: '500' });
      if (cursor !== null) query.set('cursor', cursor);
      const payload = await this.#request(`/v1/workspaces?${query}`);
      if (!Array.isArray(payload?.workspaces)) {
        throw invalidResponse('Fuli Workspace returned an invalid workspace list');
      }
      workspaces.push(...payload.workspaces.map(workspaceSpace));
      if (payload.hasMore !== true) return workspaces;
      const nextCursor = nonEmptyString(payload.nextCursor);
      if (!nextCursor || nextCursor === cursor) {
        throw invalidResponse('Fuli Workspace returned an invalid list cursor');
      }
      cursor = nextCursor;
    }
    throw invalidResponse('Fuli Workspace workspace listing exceeded the page limit');
  }

  async search(input) {
    const spaceIds = uniqueStrings(input?.space_ids);
    const text = nonEmptyString(input?.query);
    if (!spaceIds.length) return { facts: [], entities: [] };
    if (!text || text.length > 512) {
      throw new TypeError('Fuli Workspace search query must contain 1 to 512 characters');
    }
    const limit = boundedInteger(input?.limit, 20, 1, 100);
    const pages = await Promise.all(spaceIds.map(async (spaceId) => {
      const payload = await this.#request(
        `/v1/workspaces/${encodeURIComponent(spaceId)}/query`,
        {
          method: 'POST',
          body: {
            text,
            includeHistory: input?.include_historical === true,
            limit
          }
        }
      );
      if (!Array.isArray(payload?.facts)) {
        throw invalidResponse('Fuli Workspace returned an invalid query result');
      }
      return payload.facts.map((fact) => searchFact(fact, spaceId));
    }));
    return { facts: pages.flat(), entities: [] };
  }

  async graph(spaceId, limit = 500, personalProjectId = null, offset = null) {
    if (personalProjectId !== null) {
      throw new TypeError('Fuli Workspace graphs do not support personal project scope');
    }
    const safeSpaceId = nonEmptyString(spaceId);
    if (!safeSpaceId) throw new TypeError('Fuli Workspace ID is required');
    const pageLimit = boundedInteger(limit, 500, 1, 500);
    const pageOffset = offset === null
      ? 0
      : boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const payload = await this.#request(
      `/v1/workspaces/${encodeURIComponent(safeSpaceId)}/snapshot`
    );
    if (!Array.isArray(payload?.facts)) {
      throw invalidResponse('Fuli Workspace returned an invalid snapshot');
    }
    const selected = payload.facts.slice(pageOffset, pageOffset + pageLimit);
    const graph = factsGraph(selected, safeSpaceId);
    const truncated = pageOffset + selected.length < payload.facts.length;
    return {
      space_id: safeSpaceId,
      ...graph,
      truncated,
      next_offset: truncated ? pageOffset + selected.length : null
    };
  }

  createSpace() { return unsupported(); }
  listProjectReleases() { return unsupported(); }
  deleteProject() { return unsupported(); }
  createProjectRelation() { return unsupported(); }
  listProjectRelations() { return unsupported(); }
  decideProjectRelation() { return unsupported(); }
  createProposal() { return unsupported(); }
  listProposals() { return unsupported(); }
  decideProposal() { return unsupported(); }

  async #request(path, { method = 'GET', body, authenticated = true } = {}) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== this.baseUrl || !url.pathname.startsWith('/')) {
      throw new TypeError('Fuli Workspace request escaped the configured provider origin');
    }
    const headers = { accept: 'application/json' };
    if (authenticated) headers.authorization = `Bearer ${this.#accessToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal
      });
      if (!response.ok) {
        throw new ProviderRequestError(
          `Fuli Workspace provider returned HTTP ${response.status}.`,
          {
            status: response.status,
            code: response.status >= 500 ? 'provider_http_5xx' : 'provider_error'
          }
        );
      }
      return await safeJson(response);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(
        timedOut
          ? 'Fuli Workspace provider request timed out.'
          : 'Fuli Workspace provider is unavailable.',
        {
          status: timedOut ? 504 : 0,
          code: timedOut ? 'provider_timeout' : 'provider_unavailable'
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function workspaceSpace(workspace) {
  const id = nonEmptyString(workspace?.id);
  const name = nonEmptyString(workspace?.name);
  if (!id || !name) throw invalidResponse('Fuli Workspace returned an invalid workspace');
  return {
    id,
    name,
    kind: 'project',
    description: typeof workspace.description === 'string' ? workspace.description : null,
    visibility: workspace.visibility ?? null,
    status: workspace.status ?? null,
    current_revision: workspace.revision ?? null,
    created_at: workspace.createdAt ?? null,
    updated_at: workspace.updatedAt ?? null,
    owner_id: null
  };
}

function searchFact(fact, spaceId) {
  const triple = factTriple(fact);
  return {
    id: triple.id,
    fact: `${triple.subject} ${triple.predicate} ${triple.object}`,
    source_entity: triple.subject,
    target_entity: triple.object,
    relationship: triple.predicate,
    space_id: spaceId,
    defined_project_id: spaceId,
    scope_distance: 0,
    score: 1,
    origin_quadrant: fact.originQuadrant ?? 'known_known',
    confirmation_status: fact.confirmationStatus ?? 'confirmed',
    valid_at: fact.validFrom ?? fact.createdAt ?? null,
    invalid_at: fact.validTo ?? null,
    created_at: fact.createdAt ?? null
  };
}

function factsGraph(facts, spaceId) {
  const nodes = new Map();
  const edges = facts.map((fact) => {
    const triple = factTriple(fact);
    const source = entityNode(spaceId, triple.subject, fact);
    const target = entityNode(spaceId, triple.object, fact);
    nodes.set(source.id, source);
    nodes.set(target.id, target);
    return {
      id: triple.id,
      source: source.id,
      target: target.id,
      source_name: triple.subject,
      target_name: triple.object,
      type: triple.predicate,
      fact: `${triple.subject} ${triple.predicate} ${triple.object}`,
      origin_quadrant: fact.originQuadrant ?? 'known_known',
      current_quadrant: fact.originQuadrant ?? 'known_known',
      epistemic_status: 'confirmed',
      epistemic_state_explicit: true,
      confirmation_status: fact.confirmationStatus ?? 'confirmed',
      confirmation_state_explicit: true,
      profile_aspect: null,
      valid_at: fact.validFrom ?? fact.createdAt ?? null,
      invalid_at: fact.validTo ?? null,
      created_at: fact.createdAt ?? null,
      attributes: {
        workspaceId: spaceId,
        revision: fact.revision ?? null,
        confirmedBy: fact.confirmedBy ?? null,
        sources: Array.isArray(fact.sources) ? fact.sources : []
      },
      evidence: Array.isArray(fact.evidence) ? fact.evidence : []
    };
  });
  return { nodes: [...nodes.values()], edges };
}

function entityNode(spaceId, name, fact) {
  return {
    id: `workspace-entity:${stableId(spaceId, name)}`,
    name,
    type: 'WorkspaceEntity',
    group_id: spaceId,
    summary: 'Entity referenced by a confirmed shared workspace fact.',
    origin_quadrant: fact.originQuadrant ?? 'known_known',
    current_quadrant: fact.originQuadrant ?? 'known_known',
    epistemic_status: 'confirmed',
    epistemic_state_explicit: true,
    confirmation_status: fact.confirmationStatus ?? 'confirmed',
    confirmation_state_explicit: true,
    profile_aspect: null,
    created_at: fact.createdAt ?? null,
    invalid_at: null
  };
}

function factTriple(fact) {
  const id = nonEmptyString(fact?.id);
  const subject = nonEmptyString(fact?.subject);
  const predicate = nonEmptyString(fact?.predicate);
  const object = nonEmptyString(fact?.object);
  if (!id || !subject || !predicate || !object) {
    throw invalidResponse('Fuli Workspace returned an invalid fact');
  }
  return { id, subject, predicate, object };
}

function stableId(spaceId, value) {
  return createHash('sha256').update(`${spaceId}\0${value}`, 'utf8').digest('hex').slice(0, 24);
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(nonEmptyString).filter(Boolean))];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError('Fuli Workspace pagination value is invalid');
  }
  return value;
}

async function safeJson(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw invalidResponse('Fuli Workspace returned a non-JSON response');
  }
  try {
    return await response.json();
  } catch {
    throw invalidResponse('Fuli Workspace returned invalid JSON');
  }
}

function invalidResponse(message) {
  return new ProviderRequestError(message, { code: 'provider_invalid_response' });
}

function unsupported() {
  throw new TypeError('Operation is not supported by fuli-workspace-v1');
}
