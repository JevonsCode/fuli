import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUserTasteSkill,
  recommendUserTaste
} from '../src/graphiti/user-taste-skill.js';

const PREFERENCES = [
  {
    id: 'taste-ui',
    preference_key: 'ui.clarity',
    title: 'Clear product UI',
    instruction: 'Prefer restrained UI with clear information hierarchy.',
    profile_aspect: 'taste',
    preference_scope: 'global',
    confirmation_status: 'confirmed',
    attributes: { searchTerms: ['UI', 'information hierarchy'] }
  },
  {
    id: 'judgment-risk',
    preference_key: 'engineering.verify',
    title: 'Verify before changing',
    instruction: 'Use evidence and verify after modifying production behavior.',
    profile_aspect: 'judgment_preference',
    preference_scope: 'project',
    preference_project_id: 'fuli',
    confirmation_status: 'agent_confirmed',
    attributes: { searchTerms: ['verification', 'production'] }
  },
  {
    id: 'pending-style',
    preference_key: 'style.unconfirmed',
    title: 'Unconfirmed style',
    instruction: 'Do not use this as an established rule.',
    profile_aspect: 'taste',
    preference_scope: 'global',
    confirmation_status: 'pending'
  }
];

test('generated taste Skill preserves evidence status, scope, and precedence', () => {
  const result = buildUserTasteSkill({
    preferences: PREFERENCES,
    taskPrompt: 'Help me improve the UI information hierarchy.',
    personalSpaceId: 'personal-space',
    personalProjectId: 'fuli',
    generatedAt: '2026-08-04T00:00:00.000Z'
  });

  assert.equal(result.skill_name, 'user-taste');
  assert.match(result.skill_version, /^v1:[a-f0-9]{24}$/);
  assert.equal(result.source_count, 2);
  assert.equal(result.pending_source_count, 1);
  assert.equal(result.truncated, false);
  assert.match(result.markdown, /current user request and authoritative project constraints/i);
  assert.match(result.markdown, /Confirmed · global · ui\.clarity/);
  assert.match(result.markdown, /Observed · project:fuli · engineering\.verify/);
  assert.doesNotMatch(result.markdown, /style\.unconfirmed/);
  assert.equal(result.recommendations[0].preference_key, 'ui.clarity');
  assert.ok(result.recommendations[0].match_score > 0);
  assert.ok(result.recommendations[0].matched_terms.includes('ui'));
});

test('taste recommendations remain deterministic and include default rules when unmatched', () => {
  const preferences = PREFERENCES.slice(0, 2).map((item) => ({
    preferenceKey: item.preference_key,
    title: item.title,
    instruction: item.instruction,
    profileAspect: item.profile_aspect,
    preferenceScope: item.preference_scope,
    preferenceProjectId: item.preference_project_id ?? null,
    confirmationStatus: item.confirmation_status,
    reason: '',
    searchTerms: item.attributes.searchTerms
  }));
  const result = recommendUserTaste(preferences, 'Choose a release version.', 2);
  assert.deepEqual(result.map(({ preference_key: key }) => key), [
    'ui.clarity',
    'engineering.verify'
  ]);
  assert.equal(result[0].match_score, 0);
  assert.match(result[0].reason, /default profile rule/i);
});

test('taste Skill version changes when durable preference content grows', () => {
  const first = buildUserTasteSkill({ preferences: PREFERENCES.slice(0, 1) });
  const second = buildUserTasteSkill({ preferences: PREFERENCES.slice(0, 2) });
  assert.notEqual(first.skill_version, second.skill_version);
});
