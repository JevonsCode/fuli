import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { ApplicationError, ApplicationErrorCode } from '../src/app/application-error.js';
import { createApplication } from '../src/app/create-application.js';
import { FactScope, FactStatus, Sensitivity, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';

const SECRET = 'sk-live-12345678901234567890';
const RESTRICTED = 'restricted-personal-marker';
const CROSS_SOURCE = 'cross-space-source-marker';
const CANDIDATE_BODY = 'candidate-private-body-marker';
const CANDIDATE_METADATA = 'candidate-private-metadata-marker';
const SENSITIVE_REASON = 'password=super-secret-candidate-reason';
const SUGGESTED = 'suggested-personal-marker';
const MALFORMED_SCOPE = 'malformed-personal-scope-marker';
const PUBLIC_RESTRICTED = 'public-restricted-legacy-marker';
const PUBLIC_SECRET_SUBJECT = 'password=public-secret-subject';

for (const [label, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SQLite', () => new SqliteStore(':memory:')]
]) {
  test(`${label} agent reads enforce public and Personal Lens boundaries`, () => {
    const store = createStore();
    const fixture = createPrivacyFixture(store);
    const app = createApplication({ store, activePersonalSpaceName: fixture.personal.name });

    const lens = callAgentTool(app, 'get_user_lens', { task: '', budget: 4096 });
    assert.equal(lens.facts.some((fact) => fact.id === fixture.normalFact.id), true);
    assert.equal(JSON.stringify(lens).includes(SECRET), false);
    assert.equal(JSON.stringify(lens).includes(RESTRICTED), false);

    for (const spaceId of [fixture.personal.id, 'missing-space', 'forged-space']) {
      assertPublicReadRejected(app, 'get_current_facts', { spaceId });
      assertPublicReadRejected(app, 'get_timeline', { spaceId, subject: 'user' });
      assertPublicReadRejected(app, 'get_project_rules', { spaceId });
      assertPublicReadRejected(app, 'get_fact_history', {
        spaceId,
        predicate: 'private_note'
      });
    }

    const search = callAgentTool(app, 'search_context', {
      personalSpaceId: fixture.personal.id,
      query: ''
    });
    assert.equal(search.matches.some(({ fact }) => fact.id === fixture.normalFact.id), true);
    assert.equal(search.matches.some(({ fact }) => fact.id === fixture.publicFact.id), true);
    const sourceRedacted = search.matches.find(({ fact }) => fact.id === fixture.sourceSecretFact.id);
    assert.equal(sourceRedacted.source, null);
    assert.equal(sourceRedacted.fact.sourceEpisodeId, null);
    assert.equal(search.spaceIds.includes(fixture.unsubscribed.id), false);
    assertSafeSerialization(search, fixture);

    const listed = callAgentTool(app, 'list_candidates', {
      personalSpaceId: fixture.personal.id
    });
    const safeCandidate = listed.candidates.find(({ id }) => id === 'private-candidate');
    assert.deepEqual(Object.keys(safeCandidate.source).sort(), [
      'createdAt', 'id', 'kind', 'uri'
    ]);
    assert.equal(listed.candidates.find(({ id }) => id === 'cross-source-candidate').source, null);
    assert.equal(listed.candidates.find(({ id }) => id === 'sensitive-source-candidate').source, null);
    assert.equal(listed.candidates.find(({ id }) => id === 'sensitive-reason-candidate').reason, null);
    const personalTarget = listed.candidates.find(({ id }) => id === 'personal-target-candidate');
    assert.equal(personalTarget.targetSpaceId, null);
    assert.equal(personalTarget.targetSpaceName, null);
    assertCandidateSerialization(listed, fixture);

    const pack = callAgentTool(app, 'get_context_pack', {
      personalSpaceId: fixture.personal.id,
      spaceId: fixture.project.id,
      query: ''
    });
    assert.equal(pack.matches.some(({ fact }) => fact.id === fixture.normalFact.id), true);
    assert.equal(pack.matches.some(({ fact }) => fact.id === fixture.publicFact.id), true);
    assert.equal(pack.candidateCount, listed.candidates.length);
    assert.deepEqual(pack.candidates, listed.candidates);
    assert.equal(Object.hasOwn(pack.candidates[0].source, 'preview'), false);
    assert.equal(pack.candidates.find(({ id }) => id === 'cross-source-candidate').source, null);
    assertSafeSerialization(pack, fixture);
    assertCandidateSerialization(pack, fixture);
    assert.equal(JSON.stringify(pack).includes(SUGGESTED), false);
    assertPublicLegacyReads(app, fixture);

    assertReadRejected(app, 'search_context', {
      personalSpaceId: fixture.project.id,
      query: ''
    });
    assertReadRejected(app, 'search_context', { personalSpaceId: 'missing-space', query: '' });
    assertReadRejected(app, 'list_candidates', { personalSpaceId: fixture.project.id });
    assertReadRejected(app, 'list_candidates', { personalSpaceId: 'missing-space' });
    assertReadRejected(app, 'get_context_pack', {
      personalSpaceId: fixture.project.id,
      spaceId: fixture.project.id,
      query: ''
    });
    assertReadRejected(app, 'get_context_pack', {
      personalSpaceId: fixture.personal.id,
      spaceId: fixture.personal.id,
      query: ''
    });
    assertReadRejected(app, 'get_context_pack', {
      personalSpaceId: fixture.personal.id,
      spaceId: 'missing-space',
      query: ''
    });

    app.close();
  });
}

test('public-only agent reads preserve their public result shapes', () => {
  const store = new FileStore(':memory:');
  const fixture = createPrivacyFixture(store);
  const app = createApplication({ store, activePersonalSpaceName: fixture.personal.name });

  const current = callAgentTool(app, 'get_current_facts', { spaceId: fixture.project.id });
  const timeline = callAgentTool(app, 'get_timeline', {
    spaceId: fixture.project.id,
    subject: 'Project'
  });
  const rules = callAgentTool(app, 'get_project_rules', { spaceId: fixture.project.id });
  const history = callAgentTool(app, 'get_fact_history', {
    spaceId: fixture.project.id,
    predicate: 'api_base'
  });

  assert.deepEqual(
    current.facts.map((fact) => fact.id),
    [fixture.publicFact.id, fixture.publicRelationFact.id]
  );
  assert.deepEqual(
    timeline.facts.map((fact) => fact.id),
    [fixture.publicFact.id, fixture.publicRelationFact.id]
  );
  assert.equal(rules.parameters[0].source.body, 'public-source-marker');
  assert.equal(history.facts[0].source.body, 'public-source-marker');
  for (const result of [current, timeline, rules, history]) {
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(MALFORMED_SCOPE), false);
    assert.equal(serialized.includes(fixture.crossSource.id), false);
    assert.equal(serialized.includes(CROSS_SOURCE), false);
  }
  app.close();
});

function createPrivacyFixture(store) {
  const personal = store.createSpace('Agent User', SpaceKind.PERSONAL);
  const other = store.createSpace('Other User', SpaceKind.PERSONAL);
  const project = store.createSpace('Project', SpaceKind.PUBLIC);
  const unsubscribed = store.createSpace('Unsubscribed', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  const normalSource = store.addEpisode(personal.id, 'legacy', 'safe-personal-source');
  const restrictedSource = store.addEpisode(personal.id, 'legacy', RESTRICTED);
  const secretSource = store.addEpisode(personal.id, 'legacy', `secret source ${SECRET}`);
  const crossSource = store.addEpisode(other.id, 'legacy', CROSS_SOURCE);
  const publicSource = store.addEpisode(project.id, 'prd', 'public-source-marker');
  const publicSecretSource = store.addEpisode(
    project.id,
    'prd',
    `unsafe public source ${SECRET}`,
    'prd://unsafe-public',
    { imported: true }
  );
  const unsubscribedSource = store.addEpisode(unsubscribed.id, 'prd', 'unsubscribed-source');
  const candidateSource = store.addEpisode(
    personal.id,
    'chat',
    CANDIDATE_BODY,
    'chat://candidate-safe',
    { private: CANDIDATE_METADATA }
  );
  const sensitiveCandidateSource = store.addEpisode(
    personal.id,
    'chat',
    'safe candidate body',
    'chat://candidate-sensitive',
    { credential: SECRET }
  );

  const normalFact = addFact(store, {
    id: 'personal-normal', spaceId: personal.id, sourceEpisodeId: normalSource.id,
    object: 'normal-personal-marker'
  });
  const restrictedFact = addFact(store, {
    id: 'personal-restricted', spaceId: personal.id, sourceEpisodeId: restrictedSource.id,
    object: RESTRICTED, sensitivity: Sensitivity.RESTRICTED
  });
  const secretFact = addFact(store, {
    id: 'hidden-secret-fact', spaceId: personal.id, sourceEpisodeId: secretSource.id,
    object: SECRET
  });
  const sourceSecretFact = addFact(store, {
    id: 'safe-fact-redacted-source', spaceId: personal.id, sourceEpisodeId: secretSource.id,
    object: 'safe-source-redaction'
  });
  const relationFact = addFact(store, {
    id: 'personal-relation', spaceId: personal.id, sourceEpisodeId: crossSource.id,
    object: 'safe-relation-probe', replacedByFactId: restrictedFact.id
  });
  addFact(store, {
    id: 'personal-suggested', spaceId: personal.id, sourceEpisodeId: normalSource.id,
    object: SUGGESTED, status: FactStatus.SUGGESTED
  });
  const publicFact = addFact(store, {
    id: 'public-api', spaceId: project.id, sourceEpisodeId: publicSource.id,
    subject: 'Project', predicate: 'has_api_base', object: 'https://public.example.com',
    scope: FactScope.PUBLIC
  });
  addFact(store, {
    id: 'malformed-public-scope', spaceId: project.id, sourceEpisodeId: publicSource.id,
    subject: 'Project', predicate: 'has_malformed_scope', object: MALFORMED_SCOPE,
    scope: FactScope.PERSONAL
  });
  const crossSourcePublicFact = addFact(store, {
    id: 'public-cross-source', spaceId: project.id, sourceEpisodeId: crossSource.id,
    subject: 'Project', predicate: 'has_cross_source', object: 'safe-public-cross-source',
    scope: FactScope.PUBLIC
  });
  const publicRestrictedFact = addFact(store, {
    id: 'public-restricted-legacy', spaceId: project.id, sourceEpisodeId: publicSource.id,
    subject: 'Project', predicate: 'has_restricted_legacy', object: PUBLIC_RESTRICTED,
    scope: FactScope.PUBLIC, sensitivity: Sensitivity.RESTRICTED
  });
  const publicSecretFact = addFact(store, {
    id: 'public-secret-legacy', spaceId: project.id, sourceEpisodeId: publicSource.id,
    subject: PUBLIC_SECRET_SUBJECT, predicate: 'has_secret_legacy', object: 'safe-looking',
    scope: FactScope.PUBLIC
  });
  const publicSecretSourceFact = addFact(store, {
    id: 'public-secret-source', spaceId: project.id, sourceEpisodeId: publicSecretSource.id,
    subject: 'Project', predicate: 'has_secret_source', object: 'safe-public-secret-source',
    scope: FactScope.PUBLIC
  });
  const publicRestrictedReplacement = addFact(store, {
    id: 'public-restricted-replacement', spaceId: project.id, sourceEpisodeId: publicSource.id,
    subject: 'Project', predicate: 'has_relation', object: 'restricted replacement',
    scope: FactScope.PUBLIC, sensitivity: Sensitivity.RESTRICTED
  });
  const publicRelationFact = addFact(store, {
    id: 'public-safe-relation', spaceId: project.id, sourceEpisodeId: publicSource.id,
    subject: 'Project', predicate: 'has_relation', object: 'safe public relation',
    scope: FactScope.PUBLIC, replacedByFactId: publicRestrictedReplacement.id
  });
  addFact(store, {
    id: 'unsubscribed-fact', spaceId: unsubscribed.id, sourceEpisodeId: unsubscribedSource.id,
    subject: 'Unsubscribed', object: 'unsubscribed-marker', scope: FactScope.PUBLIC
  });
  store.addCandidate({
    id: 'private-candidate', personalSpaceId: personal.id, targetSpaceId: project.id,
    episodeId: candidateSource.id, reason: 'manual review'
  });
  store.addCandidate({
    id: 'cross-source-candidate', personalSpaceId: personal.id, targetSpaceId: project.id,
    episodeId: crossSource.id, reason: 'manual review'
  });
  store.addCandidate({
    id: 'sensitive-source-candidate', personalSpaceId: personal.id,
    targetSpaceId: project.id, episodeId: sensitiveCandidateSource.id, reason: 'manual review'
  });
  store.addCandidate({
    id: 'sensitive-reason-candidate', personalSpaceId: personal.id,
    targetSpaceId: project.id, episodeId: candidateSource.id, reason: SENSITIVE_REASON
  });
  store.addCandidate({
    id: 'personal-target-candidate', personalSpaceId: personal.id,
    targetSpaceId: other.id, episodeId: candidateSource.id, reason: 'manual review'
  });

  return {
    personal, other, project, unsubscribed, normalFact, restrictedFact, secretFact, sourceSecretFact,
    relationFact,
    publicFact, crossSourcePublicFact, publicRestrictedFact, publicSecretFact,
    publicSecretSourceFact, publicRestrictedReplacement, publicRelationFact,
    publicSecretSource, crossSource, secretSource
  };
}

function addFact(store, overrides) {
  return store.addFact({
    spaceId: overrides.spaceId,
    subject: overrides.subject ?? 'user',
    predicate: overrides.predicate ?? 'private_note',
    object: overrides.object,
    sourceEpisodeId: overrides.sourceEpisodeId,
    scope: overrides.scope ?? FactScope.PERSONAL,
    status: overrides.status ?? FactStatus.CONFIRMED,
    sensitivity: overrides.sensitivity ?? Sensitivity.NORMAL,
    id: overrides.id,
    replacedByFactId: overrides.replacedByFactId
  });
}

function assertPublicLegacyReads(app, fixture) {
  const results = [
    callAgentTool(app, 'get_current_facts', { spaceId: fixture.project.id }),
    callAgentTool(app, 'get_timeline', { spaceId: fixture.project.id, subject: 'Project' }),
    callAgentTool(app, 'get_project_rules', { spaceId: fixture.project.id }),
    callAgentTool(app, 'get_fact_history', {
      spaceId: fixture.project.id,
      predicate: 'relation'
    }),
    callAgentTool(app, 'search_context', {
      personalSpaceId: fixture.personal.id,
      query: ''
    }),
    callAgentTool(app, 'get_context_pack', {
      personalSpaceId: fixture.personal.id,
      spaceId: fixture.project.id,
      query: ''
    })
  ];
  const hidden = [
    SECRET,
    PUBLIC_RESTRICTED,
    PUBLIC_SECRET_SUBJECT,
    fixture.crossSourcePublicFact.id,
    fixture.publicRestrictedFact.id,
    fixture.publicSecretFact.id,
    fixture.publicSecretSourceFact.id,
    fixture.publicRestrictedReplacement.id,
    fixture.publicSecretSource.id,
    fixture.crossSource.id,
    fixture.other.id,
    fixture.other.name
  ];
  for (const result of results) {
    const serialized = JSON.stringify(result);
    for (const value of hidden) {
      assert.equal(serialized.includes(value), false, `leaked public legacy data: ${value}`);
    }
  }
  for (const result of [results[0], results[1], results[2], results[4], results[5]]) {
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(fixture.publicFact.id), true);
    assert.equal(serialized.includes(fixture.publicRelationFact.id), true);
  }
  assert.equal(JSON.stringify(results[3]).includes(fixture.publicRelationFact.id), true);
  for (const result of results.slice(0, 5)) {
    const serialized = JSON.stringify(result);
    if (serialized.includes(fixture.publicRelationFact.id)) {
      assert.equal(serialized.includes(fixture.publicRestrictedReplacement.id), false);
    }
  }
}

function assertPublicReadRejected(app, name, input) {
  assertReadRejected(app, name, input);
}

function assertReadRejected(app, name, input) {
  assert.throws(
    () => callAgentTool(app, name, input),
    (error) => error instanceof ApplicationError && [
      ApplicationErrorCode.NOT_FOUND,
      ApplicationErrorCode.VALIDATION
    ].includes(error.code)
  );
}

function assertSafeSerialization(result, fixture) {
  const serialized = JSON.stringify(result);
  for (const hidden of [
    SECRET,
    RESTRICTED,
    CANDIDATE_BODY,
    CROSS_SOURCE,
    fixture.restrictedFact.id,
    fixture.secretFact.id,
    fixture.crossSource.id,
    fixture.secretSource.id,
    fixture.unsubscribed.id
  ]) {
    assert.equal(serialized.includes(hidden), false, `leaked ${hidden}`);
  }
}

function assertCandidateSerialization(result, fixture) {
  const serialized = JSON.stringify(result.candidates);
  for (const hidden of [
    CANDIDATE_BODY,
    CANDIDATE_METADATA,
    SENSITIVE_REASON,
    SECRET,
    CROSS_SOURCE,
    fixture.crossSource.id,
    fixture.other.id,
    fixture.other.name
  ]) {
    assert.equal(serialized.includes(hidden), false, `leaked candidate data: ${hidden}`);
  }
  assert.equal(serialized.includes('"episode"'), false);
  assert.equal(serialized.includes('"episodeId"'), false);
  assert.equal(serialized.includes('"metadata"'), false);
  assert.equal(serialized.includes('"preview"'), false);
}
