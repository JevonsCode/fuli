import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { getWritingTasteProfile } from '../src/graphiti/writing-taste-profile-workflow.js';

const CONFIG = {
  version: 1,
  personal: {
    providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'personal-token',
    principalId: 'person-local',
    spaceId: 'personal-space'
  },
  workspaces: []
};

test('older open conflicts block writing readiness even after the first conflict page', async () => {
  const offsets = [];
  const app = {
    getKnowledgeGraph: async () => ({ nodes: ['a', 'b', 'c'].map(id => confirmedWritingPreference(id, `Writing rule ${id}`)), edges: [] }),
    personal: { listPreferenceConflicts: async (_space, status, limit, offset) => {
      assert.equal(status, 'ai_pending'); assert.equal(limit, 500); offsets.push(offset);
      return offset === 0 ? Array.from({ length: 500 }, (_, i) => ({ id: `irrelevant-${i}`, left_item_id: 'other', right_item_id: 'outside' }))
        : [{ id: 'older-open-conflict', status: 'ai_pending', left_item_id: 'a', right_item_id: 'b' }];
    } }
  };
  const profile = await getWritingTasteProfile(app, { personalSpaceId: 'space' });
  assert.deepEqual(offsets, [0, 500]);
  assert.equal(profile.status, 'collecting');
  assert.equal(profile.readiness.conflict_count, 1);
});

test('writing taste profile derives readiness from the private personal graph', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/spaces/personal-space/graph': {
        space_id: 'personal-space',
        nodes: [
          confirmedWritingPreference('writing-direct', 'Prefer direct writing.'),
          confirmedWritingPreference('writing-headings', 'Prefer descriptive headings.'),
          confirmedWritingPreference('writing-examples', 'Prefer one concrete example.')
        ],
        edges: []
      },
      '/v1/preference-conflicts': []
    })
  });

  const result = await app.getWritingTasteProfile({
    personalSpaceId: 'personal-space'
  });

  assert.equal(result.status, 'active');
  assert.equal(result.scope.personal_space_id, 'personal-space');
  assert.equal(result.readiness.confirmed_rule_count, 3);
  assert.match(result.profile_markdown, /User Writing Taste/);
  assert.equal(
    calls.filter(({ path }) => path === '/v1/spaces/personal-space/graph').length,
    1
  );
});

test('writing taste profile follows every graph page before deriving readiness', async () => {
  const calls = [];
  const rules = [
    confirmedWritingPreference('writing-direct', 'Prefer direct writing.'),
    confirmedWritingPreference('writing-headings', 'Prefer descriptive headings.'),
    confirmedWritingPreference('writing-examples', 'Prefer one concrete example.')
  ];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async (rawUrl, options = {}) => {
      const url = new URL(rawUrl);
      calls.push({ path: url.pathname, search: url.search, method: options.method ?? 'GET' });
      if (url.pathname === '/v1/preference-conflicts') return jsonResponse([]);
      const offset = Number(url.searchParams.get('offset'));
      return jsonResponse({
        space_id: 'personal-space',
        nodes: [rules[offset]],
        edges: [],
        truncated: offset < rules.length - 1,
        next_offset: offset < rules.length - 1 ? offset + 1 : null
      });
    }
  });

  const result = await app.getWritingTasteProfile({
    personalSpaceId: 'personal-space',
    limit: 1
  });

  assert.equal(result.status, 'active');
  assert.equal(result.readiness.rule_count, 3);
  assert.deepEqual(
    calls
      .filter(({ path }) => path === '/v1/spaces/personal-space/graph')
      .map(({ search }) => new URLSearchParams(search).get('offset')),
    ['0', '1', '2']
  );
});

function confirmedWritingPreference(id, summary) {
  return {
    id,
    name: id,
    type: 'WritingTaste',
    summary,
    profile_aspect: 'taste',
    preference_key: id,
    preference_scope: 'global',
    epistemic_state_explicit: true,
    confirmation_state_explicit: true,
    confirmation_status: 'confirmed',
    confirmation_basis: {
      existence_reason: 'The user directly selected this writing preference.',
      quadrant_reason: 'The preference was explicitly stated.',
      proposed_by: { kind: 'user', label: 'Test user' },
      confirmed_by: { kind: 'user', label: 'Test user' },
      confirmed_at: '2026-08-05T00:00:00.000Z',
      agent_policy_version: null
    },
    attributes: { tasteDomain: 'writing' },
    evidence: []
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function providerFetch(calls, routes) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      method: options.method ?? 'GET'
    });
    const payload = routes[url.pathname] ?? [];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
