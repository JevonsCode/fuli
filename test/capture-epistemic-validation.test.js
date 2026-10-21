import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/app/application-error.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { providerEpisode } from '../src/graphiti/knowledge-provider-mapping.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';

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

test('capture rejects a non-known-known entity without reasoning before Provider I/O', async () => {
  let providerCalls = 0;
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await assert.rejects(
    app.captureSessionKnowledge(captureInput()),
    (error) => error instanceof ApplicationError &&
      error.code === 'validation' &&
      error.message === 'entities[0].reasoningSummary is required when ' +
        'originQuadrant is known_unknown'
  );
  assert.equal(providerCalls, 0);
});

test('capture rejects a non-known-known relationship without reasoning before Provider I/O', async () => {
  let providerCalls = 0;
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const input = captureInput();
  input.entities[0].originQuadrant = 'known_known';
  input.relationships = [{
    key: 'synthetic:step-x-recommends-step-y',
    source: 'synthetic:known-unknown',
    target: 'synthetic:known-unknown',
    type: 'RECOMMENDS_NEXT',
    fact: 'Synthetic step X is often followed by synthetic step Y.',
    originQuadrant: 'unknown_known',
    confirmationStatus: 'pending',
    confirmationBasis: {
      existenceReason: 'The synthetic interaction pattern repeated.',
      quadrantReason: 'The pattern was inferred from behavior.',
      proposedBy: { kind: 'agent', label: 'Acceptance Agent' }
    },
    attributes: { fixture: 'synthetic' }
  }];

  await assert.rejects(
    app.captureSessionKnowledge(input),
    (error) => error instanceof ApplicationError &&
      error.code === 'validation' &&
      error.message === 'relationships[0].reasoningSummary is required when ' +
        'originQuadrant is unknown_known'
  );
  assert.equal(providerCalls, 0);
});

function captureInput() {
  return {
    targetKind: 'personal',
    spaceId: 'personal-space',
    personalProjectId: 'fuli',
    idempotencyKey: 'synthetic-capture-validation-v1',
    sessionId: 'synthetic-capture-validation',
    name: 'Synthetic capture validation',
    sourceKind: 'synthetic_acceptance_fixture',
    sourceDescription: 'Synthetic acceptance data, not a production fact.',
    referenceTime: '2026-08-03T00:00:00.000Z',
    sensitivity: 'private',
    entities: [{
      key: 'synthetic:known-unknown',
      name: 'Synthetic unresolved tradeoff',
      type: 'ProductExploration',
      summary: 'Synthetic acceptance data.',
      originQuadrant: 'known_unknown',
      confirmationStatus: 'pending',
      confirmationBasis: {
        existenceReason: 'The synthetic fixture explicitly raises the tradeoff.',
        quadrantReason: 'The tradeoff is recognized but unresolved.',
        proposedBy: { kind: 'agent', label: 'Acceptance Agent' }
      },
      attributes: { fixture: 'synthetic' }
    }],
    relationships: []
  };
}

function scopedEpisode(preference = false) {
  const { targetKind, spaceId, personalProjectId, sessionId, ...capture } = captureInput();
  capture.sourceExcerpt = 'Synthetic user explicitly requests this preference across all projects.';
  capture.entities[0].originQuadrant = 'known_known';
  capture.entities[0].key = preference ? 'synthetic:global-preference' : 'synthetic:project-fact';
  capture.entities[0].profileAspect = preference ? 'taste' : null;
  return capture;
}

function checkpointFixture(overrides = {}) {
  const registry = new TaskContextRegistry({ tokenFactory: () => 'fuli-task-routing-fixture' });
  const task = registry.begin({ sessionId: 'native-session', turnId: 'native-turn',
    personalProjectId: 'project-a', projectAgentId: 'agent-a', sourceApplication: 'codex', ...overrides });
  const writes = [], commits = new Map();
  const app = { config: CONFIG, taskContextRegistry: registry, getCapturePolicy: () => ({ enabled: true }),
    listProjectAgents: async () => [], personal: { conversation: async () => ({ status: 'saved' }) },
    validateCaptureSessionKnowledge: input => { providerEpisode(input); },
    preflightPersonalKnowledgeCaptures: async () => ({ status: 'validated' }),
    captureSessionKnowledge: async input => {
      writes.push(input);
      const previous = commits.get(input.idempotencyKey);
      if (previous) return { ...previous, status: 'duplicate' };
      const receipt = { route: 'personal', status: 'committed', episode_id: `episode-${commits.size}`,
        entity_ids: input.entities.map((_, index) => `entity-${commits.size}-${index}`),
        relationship_ids: input.relationships.map((_, index) => `relationship-${commits.size}-${index}`) };
      commits.set(input.idempotencyKey, receipt);
      return receipt;
    } };
  const input = { taskContextToken: task.token, sourceApplication: 'codex', disposition: 'capture_candidates',
    reason: 'Review the bounded synthetic candidates.', workLog: { status: 'completed', summary: 'Synthetic task completed.' },
    capture: { ...scopedEpisode(true), entities: [scopedEpisode(true).entities[0], scopedEpisode(false).entities[0]] },
    captureRouting: [{ scope: 'personal_global', entityKeys: ['synthetic:global-preference'], relationshipKeys: [] },
      { scope: 'current_project', entityKeys: ['synthetic:project-fact'], relationshipKeys: [] }] };
  return { app, registry, task, input, writes, commits };
}

test('checkpoint routes explicit global preferences and project knowledge into separate existing scopes', async () => {
  const { app, input, writes, registry, task } = checkpointFixture();
  input.capture.entities.push({ ...scopedEpisode(true).entities[0], key: 'project-only-preference' });
  input.captureRouting[1].entityKeys.push('project-only-preference');
  input.capture.relationships = ['synthetic:project-fact', 'project-relation-b'].map(key => ({
    key, source: 'synthetic:project-fact', target: 'project-only-preference', type: 'RELATES_TO',
    fact: 'Synthetic project-local relationship.', confirmationStatus: 'pending' }));
  input.captureRouting[1].relationshipKeys = input.capture.relationships.map(item => item.key);
  const result = await checkpointTaskKnowledge(app, input);
  assert.equal(writes.length, 2);
  const global = writes.find(item => item.personalProjectId === null);
  const project = writes.find(item => item.personalProjectId === 'project-a');
  assert.ok(global);
  assert.ok(project);
  for (const capture of writes) {
    assert.equal(capture.targetKind, 'personal');
    assert.equal(capture.spaceId, CONFIG.personal.spaceId);
    assert.equal(capture.projectAgentId, null);
    assert.equal(capture.sessionId, 'native-session');
    assert.equal(capture.sourceApplication, 'codex');
    assert.equal(capture.sourceTurnId, 'native-turn');
    assert.ok(capture.entities.every(item => item.confirmationStatus === 'pending'));
  }
  assert.equal(project.entities[1].profileAspect, 'taste', 'a project preference must stay project scoped');
  assert.deepEqual(project.entities.map(item => item.key), ['synthetic:project-fact', 'project-only-preference']);
  assert.deepEqual(project.relationships.map(item => item.key), ['synthetic:project-fact', 'project-relation-b']);
  assert.equal(result.capture_results.length, 2);
  const globalReceipt = result.capture_results.find(item => item.scope === 'personal_global');
  assert.equal(globalReceipt.status, 'committed');
  assert.ok(globalReceipt.episode_id);
  assert.ok(globalReceipt.entity_ids.length);
  assert.match(globalReceipt.review_paths[0], /\/knowledge\/personal\/personal-space\/directory\/entity\//);
  assert.deepEqual(registry.context(task.token, 'codex').checkpoint.captureResults,
    result.capture_results.map(({ review_paths, ...receipt }) => receipt));
  const replay = await checkpointTaskKnowledge(app, { ...input, captureRouting: [...input.captureRouting].reverse()
    .map(partition => ({ ...partition, entityKeys: [...partition.entityKeys].reverse(),
      relationshipKeys: [...partition.relationshipKeys].reverse() })) });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.capture_results, result.capture_results);
  assert.equal(writes.length, 2, 'a completed replay must not recapture');
});

test('scoped captures reject invalid routing and confirmation before preparing or writing anything', async () => {
  for (const mutate of [
    value => { value.input.capture = null; },
    value => { value.input.captureRouting = []; },
    value => { value.input.capture.sourceExcerpt = ''; },
    value => { value.input.captureRouting[0].sourceExcerpt = ''; },
    value => { value.input.capture.entities[0].profileAspect = null; },
    value => { value.input.capture.entities[1].confirmationStatus = 'confirmed'; },
    value => { value.input.capture.entities[1].confirmationBasis.confirmedBy = { kind: 'user' };
      value.input.capture.entities[1].confirmationBasis.confirmedAt = '2026-10-16T00:00:00Z'; },
    value => { value.input.captureRouting[1].scope = 'personal_global'; },
    value => { value.input.capture.entities[1].key = value.input.capture.entities[0].key; },
    value => { value.input.capture.entities[0].originQuadrant = 'known_unknown'; },
    value => { value.input.captureRouting[0].entityKeys.push('unknown-key'); },
    value => { value.input.captureRouting[0].entityKeys.push('synthetic:global-preference'); },
    value => { value.input.captureRouting[1].entityKeys.push('synthetic:global-preference'); },
    value => { value.input.capture.entities.push({ ...scopedEpisode().entities[0], key: 'omitted-entity' }); },
    value => { value.input.capture.relationships = [{ key: 'omitted-relationship', source: 'synthetic:project-fact',
      target: 'synthetic:project-fact', type: 'RELATES_TO', fact: 'Synthetic project fact.' }]; },
    value => { value.input.capture.relationships = [{ key: 'global-fact', source: 'synthetic:global-preference',
      target: 'synthetic:global-preference', type: 'RELATES_TO', fact: 'Synthetic non-preference relationship.' }];
      value.input.captureRouting[0].relationshipKeys.push('global-fact'); },
    value => { value.input.capture.relationships = [{ key: 'foreign-reference', source: 'synthetic:project-fact',
      target: 'synthetic:global-preference', type: 'RELATES_TO', fact: 'Synthetic cross-scope reference.' }];
      value.input.captureRouting[1].relationshipKeys.push('foreign-reference'); }
  ]) {
    const fixture = checkpointFixture();
    mutate(fixture);
    await assert.rejects(checkpointTaskKnowledge(fixture.app, fixture.input), error => error.code === 'validation');
    assert.equal(fixture.registry.context(fixture.task.token, 'codex').checkpoint, null);
    assert.equal(fixture.writes.length, 0);
  }
});

test('without a registered project, project-scoped capture waits in the session temporary project (rec#20)', async () => {
  const missing = checkpointFixture({ personalProjectId: null, projectAgentId: null });
  const ensured = [];
  missing.app.personal.ensureTemporaryProject = async input => { ensured.push(input);
    return { project_id: `temporary-${input.scope_key}`, scope_type: 'temporary' }; };
  const result = await checkpointTaskKnowledge(missing.app, missing.input);
  assert.equal(ensured.length, 1);
  assert.equal(ensured[0].lifetime, 'session');
  assert.equal(ensured[0].task_context_token, undefined, 'the task itself keeps no project');
  const held = missing.writes.find(item => item.personalProjectId?.startsWith('temporary-'));
  assert.equal(held.scopeStatus, 'undetermined', 'scope undecided, never guessed global');
  assert.deepEqual(held.entities.map(item => item.key), ['synthetic:project-fact']);
  assert.ok(missing.writes.find(item => item.personalProjectId === null), 'an explicit global preference stays global');
  assert.deepEqual(result.capture_results.map(item => item.scope).sort(), ['personal_global', 'session_temporary']);
});

test('routing evidence may override the shared excerpt without changing any other episode provenance', async () => {
  const { app, input, writes } = checkpointFixture();
  input.capture.sourceExcerpt = 'Synthetic project-only evidence.';
  input.captureRouting[0].sourceExcerpt = 'Synthetic user explicitly requests this preference across all projects.';
  await checkpointTaskKnowledge(app, input);
  const global = writes.find(item => item.personalProjectId === null);
  const project = writes.find(item => item.personalProjectId === 'project-a');
  assert.equal(global.sourceExcerpt, input.captureRouting[0].sourceExcerpt);
  assert.equal(project.sourceExcerpt, input.capture.sourceExcerpt);
  for (const item of writes) {
    assert.equal(item.name, input.capture.name);
    assert.equal(item.referenceTime, input.capture.referenceTime);
    assert.equal(item.sourceKind, input.capture.sourceKind);
  }
});

test('scoped partial failure resumes stable commits without completing early or accepting a changed payload', async () => {
  const { app, input, registry, task, commits } = checkpointFixture();
  const capture = app.captureSessionKnowledge;
  let fail = true;
  app.captureSessionKnowledge = async value => {
    if (value.personalProjectId === null && fail) throw new Error('Synthetic second-scope outage');
    return capture(value);
  };
  await assert.rejects(checkpointTaskKnowledge(app, input), /Synthetic second-scope outage/);
  assert.equal(commits.size, 1);
  assert.equal(registry.context(task.token, 'codex').checkpoint.phase, 'prepare');
  await assert.rejects(checkpointTaskKnowledge(app, { ...input, reason: 'Changed review.' }), /different input/);
  fail = false;
  const saved = await checkpointTaskKnowledge(app, input);
  assert.equal(commits.size, 2);
  assert.deepEqual(saved.capture_results.map(item => item.status), ['duplicate', 'committed']);
  assert.equal(registry.context(task.token, 'codex').checkpoint.phase, 'complete');
});

test('Provider preflight rejection is awaited before task preparation, private memory or either capture', async () => {
  const { app, input, registry, task, writes } = checkpointFixture();
  let prepared = 0, memory = 0;
  const prepare = registry.prepare.bind(registry);
  registry.prepare = async (...args) => { prepared += 1; return prepare(...args); };
  app.getProjectAgent = async () => { memory += 1; throw new Error('Unexpected memory preparation'); };
  input.agentMemory = { expectedRevision: 0, memory: { summary: 'Synthetic private memory.' } };
  app.preflightPersonalKnowledgeCaptures = async captures => {
    assert.equal(captures.length, 2);
    assert.deepEqual(captures.map(item => item.personalProjectId), ['project-a', null]);
    await Promise.resolve();
    throw new ApplicationError('validation', 'Provider rejected the second scope');
  };
  await assert.rejects(checkpointTaskKnowledge(app, input), /Provider rejected the second scope/);
  assert.equal(prepared, 0);
  assert.equal(memory, 0);
  assert.equal(writes.length, 0);
  assert.equal(registry.context(task.token, 'codex').checkpoint, null);
});

test('Application preflights both personal scopes in one authenticated Provider request using commit payloads', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ status: 'validated', count: 2 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  } });
  const inputs = [null, 'project-a'].map(personalProjectId => ({ ...captureInput(),
    personalProjectId, entities: [{ ...captureInput().entities[0], originQuadrant: 'known_known' }] }));
  await app.preflightPersonalKnowledgeCaptures(inputs);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/v1/knowledge/commits/preflight');
  assert.equal(calls[0].options.headers.authorization, 'Bearer personal-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), inputs.map(input => ({
    space_id: input.spaceId, personal_project_id: input.personalProjectId, project_agent_id: null,
    episode: providerEpisode(input)
  })));
  app.personal.preflightCommits = async () => ({ status: 'validated', count: 1 });
  await assert.rejects(app.preflightPersonalKnowledgeCaptures(inputs), /confirm every capture preflight/);
});

test('legacy capture keeps its Agent scope and retain_nothing records only the review outcome', async () => {
  const legacy = checkpointFixture();
  const { captureRouting, ...input } = legacy.input;
  const saved = await checkpointTaskKnowledge(legacy.app, { ...input, capture: scopedEpisode() });
  assert.equal(legacy.writes[0].projectAgentId, 'agent-a');
  assert.equal(legacy.writes[0].personalProjectId, 'project-a');
  assert.equal(saved.capture.status, 'committed');
  const empty = checkpointFixture();
  const { captureRouting: omitted, capture: skipped, ...review } = empty.input;
  const retained = await checkpointTaskKnowledge(empty.app, { ...review, disposition: 'retain_nothing', reason: 'Nothing reusable.' });
  assert.equal(retained.reason, 'Nothing reusable.');
  assert.equal(empty.writes.length, 0);
  assert.equal(empty.registry.context(empty.task.token, 'codex').checkpoint.disposition, 'retain_nothing');
});

test('scoped capture defaults proposals to pending and reports a disabled policy without saved IDs', async () => {
  const fixture = checkpointFixture();
  delete fixture.input.capture.entities[0].confirmationStatus;
  fixture.app.captureSessionKnowledge = async input => {
    assert.ok(input.entities.every(item => item.confirmationStatus === 'pending'));
    return { status: 'capture_disabled' };
  };
  const result = await checkpointTaskKnowledge(fixture.app, fixture.input);
  assert.equal(result.capture_status, 'capture_disabled');
  assert.ok(result.capture_results.every(item => item.status === 'capture_disabled'
    && item.episode_id === null && item.entity_ids.length === 0 && item.review_paths.length === 0));
  assert.equal(fixture.writes.length, 0);
});

test('a capture policy change between scope batches reports partial persistence and replays it honestly', async () => {
  const { app, input, registry, task } = checkpointFixture();
  const capture = app.captureSessionKnowledge;
  let enabled = true;
  app.captureSessionKnowledge = async value => {
    if (!enabled) return { status: 'capture_disabled' };
    const result = await capture(value);
    enabled = false;
    return result;
  };
  const result = await checkpointTaskKnowledge(app, input);
  assert.equal(result.capture_status, 'partial');
  assert.deepEqual(result.capture_results.map(item => item.status), ['committed', 'capture_disabled']);
  assert.equal(result.capture_results[1].episode_id, null);
  assert.equal(registry.context(task.token, 'codex').checkpoint.captureStatus, 'partial');
  const replay = await checkpointTaskKnowledge(app, input);
  assert.equal(replay.capture_status, 'partial');
  assert.deepEqual(replay.capture_results, result.capture_results);
});

test('MCP checkpoint schema accepts the scoped contract alongside the unchanged legacy contract', async () => {
  const { listAgentTools } = await import('../src/agent-tools.js');
  const { jsonSchemaToZod } = await import('../src/mcp/tool-schema.js');
  const tool = listAgentTools().find(item => item.name === 'checkpoint_task_knowledge');
  const schema = jsonSchemaToZod(tool.inputSchema);
  const { sourceApplication, ...input } = checkpointFixture().input;
  assert.equal(schema.safeParse(input).success, true);
  assert.equal(Object.hasOwn(tool.inputSchema.properties, 'captures'), false, 'do not duplicate the episode schema');
  assert.ok(JSON.stringify(tool.inputSchema.properties.captureRouting).length < 2000);
  const { captureRouting, ...legacy } = input;
  assert.equal(schema.safeParse({ ...legacy, capture: scopedEpisode() }).success, true);
});

test('a conclusion names the current items it rests on, and only when it has any (rec#5 C8-4)', () => {
  const basis = { existenceReason: 'Synthetic.', quadrantReason: 'Synthetic.', proposedBy: { kind: 'agent' } };
  const item = { key: 'fact', name: 'Template is .docx', type: 'ProjectFact', originQuadrant: 'known_known',
    confirmationStatus: 'pending', confirmationBasis: basis };
  const episode = providerEpisode({ idempotencyKey: 'synthetic-derived', sessionId: 's', name: 'n', sourceKind: 'k',
    sourceDescription: 'd', referenceTime: '2026-10-21T00:00:00Z',
    entities: [{ ...item, derivedFrom: ['preference-1'] }, { ...item, key: 'plain' }],
    relationships: [{ key: 'r', source: 'fact', target: 'plain', type: 'USES', fact: 'Uses.', originQuadrant: 'known_known',
      confirmationStatus: 'pending', confirmationBasis: basis, derivedFrom: ['preference-1', 'fact-2'] }] });
  assert.deepEqual(episode.entities[0].derived_from, ['preference-1']);
  assert.equal(Object.hasOwn(episode.entities[1], 'derived_from'), false, 'no basis, no field');
  assert.deepEqual(episode.relationships[0].derived_from, ['preference-1', 'fact-2']);
});
