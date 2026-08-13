import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphitiProviderClient, ProviderRequestError } from '../src/graphiti/provider-client.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import {
  FULI_WORKSPACE_CAPABILITIES,
  FuliWorkspaceProviderClient,
  createWorkspaceProvider
} from '../src/graphiti/workspace-provider-client.js';

const BASE_URL = 'http://127.0.0.1:8789';
const TEST_TOKEN = 'test-workspace-token-1234567890';

test('workspace provider factory keeps Graphiti as the default protocol', () => {
  const provider = createWorkspaceProvider({
    providerUrl: 'https://workspace.example',
    accessToken: TEST_TOKEN,
    principalId: 'principal-1'
  }, { fetchImpl: async () => jsonResponse({}) });

  assert.equal(provider.protocol, 'graphiti-v1');
  assert.equal(provider.client instanceof GraphitiProviderClient, true);
  assert.equal(provider.capabilities.publishProject, true);
});

test('fuli-workspace health and paginated discovery use their native endpoints', async () => {
  const calls = [];
  const client = workspaceClient(async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: options.headers?.authorization,
      redirect: options.redirect
    });
    if (url.pathname === '/healthz') {
      return jsonResponse({ status: 'ok', protocolVersion: '1' });
    }
    if (url.pathname === '/v1/auth/session') {
      return jsonResponse({ authenticated: true });
    }
    if (url.searchParams.get('cursor') === '1') {
      return jsonResponse({
        workspaces: [{
          id: 'workspace-2', name: '运行手册', description: null,
          visibility: 'private', status: 'active', revision: '2',
          createdAt: '2026-08-12T02:00:00.000Z', updatedAt: '2026-08-12T03:00:00.000Z'
        }],
        nextCursor: '2',
        hasMore: false
      });
    }
    return jsonResponse({
      workspaces: [{
        id: 'workspace-1', name: '产品事实', description: '确认的公共事实。',
        visibility: 'public', status: 'active', revision: '1',
        createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T01:00:00.000Z'
      }],
      nextCursor: '1',
      hasMore: true
    });
  });

  const health = await client.health();
  const spaces = await client.listSpaces();

  assert.equal(health.status, 'ready');
  assert.equal(health.protocol, 'fuli-workspace-v1');
  assert.deepEqual(spaces.map(({ id, kind }) => ({ id, kind })), [
    { id: 'workspace-1', kind: 'project' },
    { id: 'workspace-2', kind: 'project' }
  ]);
  assert.equal(spaces[0].current_revision, '1');
  const healthCall = calls.find(({ path }) => path === '/healthz');
  const session = calls.find(({ path }) => path === '/v1/auth/session');
  const pages = calls.filter(({ path }) => path === '/v1/workspaces');
  assert.equal(healthCall.authorization, undefined);
  assert.equal(session.authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(pages[0].query.limit, '500');
  assert.equal(pages[1].query.cursor, '1');
  assert.equal(calls.every(({ redirect }) => redirect === 'error'), true);
});

test('fuli-workspace search queries each selected workspace and maps confirmed facts', async () => {
  const calls = [];
  const client = workspaceClient(async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      body: JSON.parse(options.body),
      authorization: options.headers.authorization
    });
    const workspaceId = decodeURIComponent(url.pathname.split('/')[3]);
    return jsonResponse({
      workspaceId,
      facts: [fact(`${workspaceId}-fact`, workspaceId)],
      truncated: false,
      nextCursor: null
    });
  });

  const result = await client.search({
    space_ids: ['workspace-a', 'workspace-b', 'workspace-a'],
    query: '确认',
    limit: 12,
    include_historical: true
  });

  assert.deepEqual(calls.map(({ path }) => path), [
    '/v1/workspaces/workspace-a/query',
    '/v1/workspaces/workspace-b/query'
  ]);
  assert.deepEqual(calls[0].body, { text: '确认', includeHistory: true, limit: 12 });
  assert.equal(calls[0].authorization, `Bearer ${TEST_TOKEN}`);
  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.facts.map(({ space_id }) => space_id), [
    'workspace-a', 'workspace-b'
  ]);
  assert.equal(result.facts[0].defined_project_id, 'workspace-a');
  assert.equal(result.facts[0].origin_quadrant, 'known_known');
  assert.equal(result.facts[0].confirmation_status, 'confirmed');
});

test('fuli-workspace graph maps a native snapshot and preserves zero-based pagination', async () => {
  const calls = [];
  const client = workspaceClient(async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ path: url.pathname, authorization: options.headers.authorization });
    return jsonResponse({
      workspace: { id: 'workspace-a', revision: '3' },
      facts: [
        fact('fact-1', 'alpha', { subject: 'API', object: '/v1/workspaces' }),
        fact('fact-2', 'beta', { subject: 'UI', object: '/' })
      ],
      relations: [],
      memberships: [],
      generatedAt: '2026-08-12T05:00:00.000Z'
    });
  });

  const first = await client.graph('workspace-a', 1, null, 0);
  const second = await client.graph('workspace-a', 1, null, 1);

  assert.deepEqual(calls.map(({ path }) => path), [
    '/v1/workspaces/workspace-a/snapshot',
    '/v1/workspaces/workspace-a/snapshot'
  ]);
  assert.equal(first.edges[0].id, 'fact-1');
  assert.equal(first.nodes.length, 2);
  assert.equal(first.truncated, true);
  assert.equal(first.next_offset, 1);
  assert.equal(second.edges[0].id, 'fact-2');
  assert.equal(second.truncated, false);
  assert.equal(second.next_offset, null);
});

test('fuli-workspace errors never echo provider payloads or access tokens', async () => {
  const client = workspaceClient(async () => jsonResponse({
    error: { message: `rejected ${TEST_TOKEN}` }
  }, 401));

  await assert.rejects(client.listSpaces(), (error) => {
    assert.equal(error instanceof ProviderRequestError, true);
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(TEST_TOKEN), false);
    assert.equal(JSON.stringify(error).includes(TEST_TOKEN), false);
    return true;
  });
});

test('fuli-workspace health requires an authenticated provider session', async () => {
  const client = workspaceClient(async (rawUrl) => {
    const { pathname } = new URL(rawUrl);
    if (pathname === '/healthz') {
      return jsonResponse({ status: 'ok', protocolVersion: '1' });
    }
    return jsonResponse({
      error: { message: `invalid token ${TEST_TOKEN}` }
    }, 401);
  });

  await assert.rejects(client.health(), (error) => {
    assert.equal(error instanceof ProviderRequestError, true);
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(TEST_TOKEN), false);
    return true;
  });
});

test('fuli-workspace advertises only the implemented public capability slice', () => {
  assert.deepEqual(FULI_WORKSPACE_CAPABILITIES, {
    browsePublicProjects: true,
    publishProject: false,
    submitKnowledge: false,
    subscribeProject: true,
    reviewProposals: false,
    query: true
  });
});

test('federated state exposes only the capabilities implemented by fuli-workspace', async () => {
  const calls = [];
  const routes = {
    '/health': {
      status: 'ready', providerId: 'local-personal', mode: 'personal',
      storage: 'graphiti-neo4j'
    },
    '/healthz': { status: 'ok', protocolVersion: '1' },
    '/v1/auth/session': { authenticated: true },
    '/v1/spaces': [{ id: 'personal-space', name: '我', kind: 'personal' }],
    '/v1/workspaces': {
      workspaces: [{
        id: 'workspace-1', name: '公共事实', description: '已确认的项目事实。',
        visibility: 'public', status: 'active', revision: '1',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z'
      }],
      nextCursor: '1',
      hasMore: false
    },
    '/v1/personal-projects': [],
    '/v1/subscriptions': []
  };
  const app = new FederatedGraphApplication({
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787', accessToken: 'personal-token',
      principalId: 'person-local', spaceId: 'personal-space'
    },
    workspaces: [{
      protocol: 'fuli-workspace-v1', providerUrl: BASE_URL,
      accessToken: TEST_TOKEN, principalId: 'person-remote'
    }]
  }, {
    fetchImpl: async (rawUrl, options = {}) => {
      const url = new URL(rawUrl);
      calls.push({ origin: url.origin, path: url.pathname, options });
      return jsonResponse(routes[url.pathname] ?? []);
    }
  });

  const state = await app.state();

  assert.equal(state.mode, 'connected');
  assert.equal(state.projects[0].id, 'workspace-1');
  assert.deepEqual(state.capabilities, {
    browsePublicProjects: true,
    publishProject: false,
    submitKnowledge: false,
    subscribeProject: true,
    reviewProposals: false
  });
  assert.equal(state.providers.workspaces[0].protocol, 'fuli-workspace-v1');
  assert.equal(state.providers.workspaces[0].capabilities.query, true);
  assert.equal(calls.some(({ origin, path }) =>
    origin === BASE_URL && path === '/health'), false);
  assert.equal(calls.some(({ origin, path }) =>
    origin === BASE_URL && path === '/healthz'), true);
});

function workspaceClient(fetchImpl) {
  return new FuliWorkspaceProviderClient({
    baseUrl: BASE_URL,
    accessToken: TEST_TOKEN,
    fetchImpl
  });
}

function fact(id, suffix, overrides = {}) {
  return {
    id,
    workspaceId: 'workspace-a',
    subject: overrides.subject ?? `主题-${suffix}`,
    predicate: '已经确认',
    object: overrides.object ?? `事实-${suffix}`,
    state: 'active',
    revision: '3',
    knowledgeKind: 'project_fact',
    originQuadrant: 'known_known',
    confirmationStatus: 'confirmed',
    confirmedBy: { kind: 'authoritative_source', label: '产品文档' },
    profileAspect: null,
    sensitivity: 'normal',
    evidence: [],
    sources: [{ id: 'source-1', title: '产品文档' }],
    createdAt: '2026-08-12T04:00:00.000Z',
    updatedAt: '2026-08-12T04:00:00.000Z'
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
