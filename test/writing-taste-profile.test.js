import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWritingTasteProfile,
  isWritingTasteItem
} from '../src/graphiti/writing-taste-profile.js';

test('writing taste stays collecting until evidence is broad enough', () => {
  const result = buildWritingTasteProfile({
    graph: graph([
      writingRule('direct', { status: 'confirmed' }),
      writingRule('headings', { status: 'pending' })
    ]),
    generatedAt: '2026-08-05T00:00:00.000Z'
  });

  assert.equal(result.status, 'collecting');
  assert.equal(result.ready, false);
  assert.equal(result.readiness.rule_count, 2);
  assert.equal(result.profile_markdown, null);
  assert.equal(result.agent_markdown, null);
});

test('three explicitly confirmed rules can activate a profile immediately', () => {
  const result = buildWritingTasteProfile({
    graph: graph([
      writingRule('direct', { status: 'confirmed' }),
      writingRule('headings', { status: 'confirmed' }),
      writingRule('examples', { status: 'confirmed' }),
      writingRule('unconfirmed', { status: 'pending' })
    ]),
    personalSpaceId: 'personal-1',
    generatedAt: '2026-08-05T00:00:00.000Z'
  });

  assert.equal(result.status, 'active');
  assert.equal(result.readiness.confirmed_path_ready, true);
  assert.match(result.skill_version, /^v1:[a-f0-9]{24}$/);
  assert.match(result.profile_markdown, /Working hypothesis/);
  assert.match(result.profile_markdown, /writing\.unconfirmed/);
  assert.doesNotMatch(result.agent_markdown, /writing\.unconfirmed/);
});

test('repeated observations across sessions and days unlock a reviewable preview', () => {
  const rules = [
    observedRule('direct', 0),
    observedRule('headings', 2),
    observedRule('examples', 4)
  ];
  const result = buildWritingTasteProfile({ graph: graph(rules) });

  assert.equal(result.status, 'preview_ready');
  assert.equal(result.readiness.standard_path_ready, true);
  assert.equal(result.readiness.confirmed_rule_count, 0);
  assert.equal(result.readiness.evidence_count, 6);
  assert.equal(result.readiness.session_count, 6);
  assert.equal(result.readiness.observation_day_count, 6);
  assert.match(result.agent_markdown, /Observed/);
});

test('same-scope contradictions block generation while project overrides do not', () => {
  const conflicting = buildWritingTasteProfile({
    graph: graph([
      writingRule('tone-a', {
        status: 'confirmed',
        preferenceKey: 'writing.tone',
        instruction: 'Prefer a formal tone.'
      }),
      writingRule('tone-b', {
        status: 'confirmed',
        preferenceKey: 'writing.tone',
        instruction: 'Prefer a conversational tone.'
      }),
      writingRule('headings', { status: 'confirmed' })
    ])
  });
  assert.equal(conflicting.status, 'collecting');
  assert.equal(conflicting.readiness.conflict_count, 1);

  const contextual = buildWritingTasteProfile({
    graph: graph([
      writingRule('tone-global', {
        status: 'confirmed',
        preferenceKey: 'writing.tone',
        instruction: 'Prefer a formal tone.'
      }),
      writingRule('tone-project', {
        status: 'confirmed',
        preferenceKey: 'writing.tone',
        instruction: 'Prefer a conversational tone.',
        scope: 'project',
        projectId: 'marketing'
      }),
      writingRule('headings', { status: 'confirmed' })
    ])
  });
  assert.equal(contextual.status, 'active');
  assert.equal(contextual.readiness.conflict_count, 0);
});

test('writing classification respects explicit domains and rejects unrelated taste', () => {
  assert.equal(isWritingTasteItem({
    profile_aspect: 'taste',
    summary: 'Prefer concise product copy.'
  }), true);
  assert.equal(isWritingTasteItem({
    profile_aspect: 'taste',
    summary: 'Prefer concise copy.',
    attributes: { tasteDomain: 'ui' }
  }), false);
  assert.equal(isWritingTasteItem({
    profile_aspect: 'judgment_preference',
    summary: 'Verify all writing before publishing.'
  }), false);
});

test('an optional project view combines global writing taste with only that exact project', () => {
  const result = buildWritingTasteProfile({
    graph: graph([
      writingRule('global', { status: 'confirmed' }),
      writingRule('project-a', {
        status: 'confirmed',
        scope: 'project',
        projectId: 'project-a'
      }),
      writingRule('project-b', {
        status: 'confirmed',
        scope: 'project',
        projectId: 'project-b'
      })
    ]),
    personalProjectId: 'project-a'
  });

  assert.deepEqual(
    result.rules.map(({ item_id: itemId }) => itemId).sort(),
    ['global', 'project-a']
  );
  assert.equal(result.status, 'collecting');
});

function graph(nodes) {
  return { nodes, edges: [] };
}

function writingRule(key, {
  status = 'pending',
  preferenceKey = `writing.${key}`,
  instruction = `Writing preference ${key}.`,
  scope = 'global',
  projectId = null,
  evidence = []
} = {}) {
  const confirmed = status === 'confirmed';
  const observed = status === 'agent_confirmed';
  return {
    id: key,
    name: key,
    type: 'WritingTaste',
    summary: instruction,
    profile_aspect: 'taste',
    preference_key: preferenceKey,
    preference_scope: scope,
    preference_project_id: projectId,
    confirmation_state_explicit: true,
    confirmation_status: status,
    confirmation_basis: {
      existence_reason: 'Supported by writing feedback.',
      quadrant_reason: 'The evidence concerns writing choices.',
      proposed_by: { kind: confirmed ? 'user' : 'agent', label: 'Test' },
      confirmed_by: confirmed
        ? { kind: 'user', label: 'Test user' }
        : observed
          ? { kind: 'agent', label: 'Test policy' }
          : null,
      confirmed_at: confirmed || observed ? '2026-08-05T00:00:00.000Z' : null,
      agent_policy_version: observed ? 'agent-usage-v1' : null
    },
    attributes: { tasteDomain: 'writing' },
    evidence
  };
}

function observedRule(key, startIndex) {
  return writingRule(key, {
    status: 'agent_confirmed',
    evidence: [0, 1].map((offset) => {
      const index = startIndex + offset;
      return {
        id: `${key}-evidence-${offset}`,
        session_id: `session-${index}`,
        reference_time: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`
      };
    })
  });
}
