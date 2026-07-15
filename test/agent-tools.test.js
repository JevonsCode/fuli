import test from 'node:test';
import assert from 'node:assert/strict';

import { listAgentTools, callAgentTool } from '../src/agent-tools.js';
import { createApplication } from '../src/app/create-application.js';
import { FactStatus, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';

const EXISTING_TOOL_CONTRACT = [
  ['remember_episode', 'Capture a work episode and route it into personal, public, or candidate context.'],
  ['search_context', 'Search personal context and subscribed spaces without reading the whole store.'],
  ['get_current_facts', 'Return current facts for one space.'],
  ['get_timeline', 'Return the fact timeline for one subject in one space.'],
  ['get_project_rules', 'Return current project parameters and forbidden methods with sources.'],
  ['get_fact_history', 'Return source-backed history for one predicate in one space.'],
  ['get_context_pack', 'Return a compact current context pack for one personal and project space.'],
  ['observe_git_diff', 'Observe added lines in the current Git diff and route them through ingestion.'],
  ['list_candidates', 'List pending candidate observations for a personal space.'],
  ['decide_candidate', 'Apply a human-triggered candidate decision: sync, personal_only, or ignore.']
];

const LENS_TOOL_NAMES = [
  'remember_user_fact',
  'submit_user_observation',
  'correct_user_fact',
  'confirm_observation',
  'get_user_lens',
  'search_user_context'
];

test('agent tools expose stable names and schemas', () => {
  const tools = listAgentTools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...EXISTING_TOOL_CONTRACT.map(([name]) => name), ...LENS_TOOL_NAMES]
  );
  assert.deepEqual(
    tools.slice(0, 10).map(({ name, description }) => [name, description]),
    EXISTING_TOOL_CONTRACT
  );
  assert.equal(tools[1].inputSchema.properties.personalSpaceId.type, 'string');
  assert.equal(tools[1].inputSchema.properties.query.type, 'string');

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
  assert.deepEqual(byName.remember_user_fact.required, ['predicate', 'value', 'sourceText']);
  assert.deepEqual(byName.submit_user_observation.required, [
    'predicate', 'value', 'evidenceText', 'inference'
  ]);
  assert.deepEqual(byName.correct_user_fact.required, ['factId', 'action', 'sourceText']);
  assert.deepEqual(byName.confirm_observation.required, ['factId', 'sourceText']);
  assert.deepEqual(byName.get_user_lens.required, ['task', 'budget']);
  assert.deepEqual(byName.search_user_context.required, ['query']);
  for (const name of LENS_TOOL_NAMES) {
    assert.equal(byName[name].additionalProperties, false);
    assert.equal(byName[name].properties.personalSpaceId.type, 'string');
  }
  assert.deepEqual(byName.remember_user_fact.properties.sensitivity.enum, [
    'normal', 'private', 'restricted'
  ]);
  assert.deepEqual(byName.submit_user_observation.properties.inference.enum, [
    'direct', 'inferred'
  ]);
  assert.equal(Object.hasOwn(byName.remember_user_fact.properties, 'object'), false);
  assert.equal(Object.hasOwn(byName.submit_user_observation.properties, 'object'), false);
  assert.equal(Object.hasOwn(byName.submit_user_observation.properties, 'sourceText'), false);
  assert.equal(Object.hasOwn(byName.submit_user_observation.properties, 'direct'), false);
  assert.deepEqual(byName.correct_user_fact.properties.action.enum, [
    'replace', 'reject', 'deprecate'
  ]);
  assert.equal(byName.get_user_lens.properties.budget.type, 'integer');

  tools[0].inputSchema.properties.body.type = 'number';
  tools[10].inputSchema.required.push('tampered');
  const fresh = listAgentTools();
  assert.equal(fresh[0].inputSchema.properties.body.type, 'string');
  assert.equal(fresh[10].inputSchema.required.includes('tampered'), false);
});

test('agent tools provide source-backed search without reading the whole store', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    sourceUri: 'prd://project-a/v1',
    body: 'test_url: https://agent.example.com'
  });

  const result = callAgentTool(appFor(store), 'search_context', {
    personalSpaceId: personal.id,
    query: 'agent.example'
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].source.uri, 'prd://project-a/v1');
  assert.equal(result.matches[0].fact.object, 'https://agent.example.com');
  assertNoAdapterInternals(result);
});

test('remember_episode rejects credentials without storing any record', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  const before = store.exportSnapshot();

  assert.throws(() => callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'chat',
    body: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  }), /sensitive content/i);
  assert.deepEqual(store.exportSnapshot(), before);
});

test('agent tools return current facts and timeline explicitly', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);

  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://old.example.com'
  });
  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: '替代: https://old.example.com => https://new.example.com'
  });

  const current = callAgentTool(appFor(store), 'get_current_facts', { spaceId: project.id });
  const timeline = callAgentTool(appFor(store), 'get_timeline', {
    spaceId: project.id,
    subject: 'Project A'
  });

  assert.deepEqual(
    current.facts.map((fact) => fact.object),
    ['https://new.example.com']
  );
  assert.equal(timeline.facts.length, 2);
  assertNoAdapterInternals(current);
  assertNoAdapterInternals(timeline);
});

test('agent tools return current project rules with sources', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);

  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    sourceUri: 'prd://rules',
    body: ['禁止: eval', 'api_base: https://api.example.com'].join('\n')
  });

  const result = callAgentTool(appFor(store), 'get_project_rules', {
    spaceId: project.id
  });

  assert.equal(result.spaceName, 'Project A');
  assert.equal(result.forbidden[0].object, 'eval');
  assert.equal(result.parameters[0].predicate, 'has_api_base');
  assert.equal(result.parameters[0].source.uri, 'prd://rules');
  assertNoAdapterInternals(result);
});

test('agent tools return source-backed history for one project parameter', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);

  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    sourceUri: 'prd://v1',
    body: 'test_url: https://old.example.com'
  });
  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    sourceUri: 'prd://v2',
    body: 'test_url: https://new.example.com'
  });

  const result = callAgentTool(appFor(store), 'get_fact_history', {
    spaceId: project.id,
    predicate: 'test_url'
  });

  assert.deepEqual(
    result.facts.map((fact) => [fact.object, fact.current, fact.source.uri]),
    [
      ['https://old.example.com', false, 'prd://v1'],
      ['https://new.example.com', true, 'prd://v2']
    ]
  );
  assertNoAdapterInternals(result);
});

test('agent tools build a compact context pack for one personal and project space', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    sourceUri: 'prd://project-a/rules',
    body: ['禁止: eval', 'test_url: https://pack.example.com'].join('\n')
  });
  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'chat',
    sourceUri: 'chat://project-a/candidate',
    body: 'local_alias: pnpm dev'
  });

  const result = callAgentTool(appFor(store), 'get_context_pack', {
    personalSpaceId: personal.id,
    spaceId: project.id,
    query: 'test_url'
  });

  assert.equal(result.personalSpace.name, 'Jevons');
  assert.equal(result.space.name, 'Project A');
  assert.equal(result.rules.forbidden[0].object, 'eval');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].fact.object, 'https://pack.example.com');
  assert.equal(result.matches[0].source.uri, 'prd://project-a/rules');
  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].source.uri, 'chat://project-a/candidate');
  assert.equal(Object.hasOwn(result, 'episodes'), false);
  assert.equal(Object.hasOwn(result, 'facts'), false);
  assert.equal(Object.hasOwn(result.rules, 'facts'), false);
  assertNoAdapterInternals(result);
});

test('agent context pack includes compact replacement history for matched facts', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    sourceUri: 'prd://project-a/v1',
    body: 'test_url: https://old.example.com'
  });
  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    sourceUri: 'prd://project-a/v2',
    body: 'test_url: https://new.example.com'
  });

  const result = callAgentTool(appFor(store), 'get_context_pack', {
    personalSpaceId: personal.id,
    spaceId: project.id,
    query: 'test_url'
  });

  assert.equal(result.matches[0].fact.object, 'https://new.example.com');
  assert.equal(result.histories.length, 1);
  assert.equal(result.histories[0].predicate, 'has_test_url');
  assert.deepEqual(
    result.histories[0].facts.map((fact) => [fact.object, fact.current, fact.source.uri]),
    [
      ['https://old.example.com', false, 'prd://project-a/v1'],
      ['https://new.example.com', true, 'prd://project-a/v2']
    ]
  );
  assert.equal(Object.hasOwn(result.histories[0].facts[0].source, 'body'), false);
  assertNoAdapterInternals(result);
});

test('agent tool execution rejects unknown tools', () => {
  const store = new FileStore(':memory:');

  assert.throws(
    () => callAgentTool(appFor(store), 'unknown_tool', {}),
    /Unknown agent tool: unknown_tool/
  );
});

test('agent tools let a human-triggered candidate decision grow personal context', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);

  callAgentTool(appFor(store), 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'chat',
    sourceUri: 'chat://agent-candidate',
    body: 'local_alias: pnpm dev'
  });
  const candidates = callAgentTool(appFor(store), 'list_candidates', {
    personalSpaceId: personal.id
  });

  const decision = callAgentTool(appFor(store), 'decide_candidate', {
    candidateId: candidates.candidates[0].id,
    decision: 'personal_only'
  });
  const search = callAgentTool(appFor(store), 'search_context', {
    personalSpaceId: personal.id,
    query: 'local_alias'
  });

  assert.equal(decision.candidate.status, 'personal_only');
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].spaceName, 'Jevons');
  assert.equal(search.matches[0].source.uri, 'chat://agent-candidate');
  assertNoAdapterInternals(candidates);
  assertNoAdapterInternals(decision);
  assertNoAdapterInternals(search);
});

test('remember_user_fact accepts the Task 10 contract and defaults subject to user', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  const { personal } = app.bootstrap();

  const result = callAgentTool(app, 'remember_user_fact', {
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我熟悉 JavaScript',
    sourceKind: 'conversation',
    sensitivity: 'private',
    confidence: 0.9
  });

  assert.equal(result.fact.spaceId, personal.id);
  assert.equal(result.fact.subject, 'user');
  assert.equal(result.fact.object, 'JavaScript');
  assert.equal(result.fact.status, FactStatus.CONFIRMED);
  assert.equal(result.episode.body, '我熟悉 JavaScript');
  assert.equal(result.fact.sourceEpisodeId, result.episode.id);
  assertNoAdapterInternals(result);
});

test('submit_user_observation forwards direct and inferred observations', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  const personal = app.createSpace('Jevons', SpaceKind.PERSONAL);

  const direct = callAgentTool(app, 'submit_user_observation', {
    personalSpaceId: personal.id,
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: '用户直接要求拆分模块',
    inference: 'direct'
  });
  const inferred = callAgentTool(app, 'submit_user_observation', {
    personalSpaceId: personal.id,
    predicate: 'prefers_concise_output',
    value: 'true',
    evidenceText: '连续多次要求简洁输出',
    inference: 'inferred'
  });

  assert.equal(direct.fact.status, FactStatus.OBSERVED);
  assert.equal(direct.episode.body, '用户直接要求拆分模块');
  assert.equal(inferred.fact.status, FactStatus.SUGGESTED);
  assert.equal(inferred.fact.spaceId, personal.id);
});

test('get_user_lens excludes suggested observations by default and can include them explicitly', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  app.bootstrap();
  const suggested = callAgentTool(app, 'submit_user_observation', {
    predicate: 'prefers_concise_output',
    value: 'true',
    evidenceText: '连续多次要求简洁输出',
    inference: 'inferred'
  });

  const defaultLens = callAgentTool(app, 'get_user_lens', {
    task: 'concise output',
    budget: 1000
  });
  const expandedLens = callAgentTool(app, 'get_user_lens', {
    task: 'concise output',
    budget: 1000,
    includeSuggested: true
  });

  assert.equal(defaultLens.facts.some(({ id }) => id === suggested.fact.id), false);
  assert.equal(expandedLens.facts.some(({ id }) => id === suggested.fact.id), true);
  assertNoAdapterInternals(expandedLens);
});

test('confirm_observation is the promotion path from observed to confirmed', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  app.bootstrap();
  const observed = callAgentTool(app, 'submit_user_observation', {
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: '用户直接要求小模块',
    inference: 'direct'
  });

  const result = callAgentTool(app, 'confirm_observation', {
    factId: observed.fact.id,
    sourceText: '我确认偏好小模块'
  });

  assert.equal(result.fact.status, FactStatus.CONFIRMED);
  assert.equal(result.replacedFact.id, observed.fact.id);
  assert.equal(result.episode.body, '我确认偏好小模块');
  assert.equal(store.getFact(observed.fact.id).replacedByFactId, result.fact.id);
});

test('correct_user_fact replaces a fact and preserves searchable correction history', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  app.bootstrap();
  const original = callAgentTool(app, 'remember_user_fact', {
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我偏好 JavaScript'
  });

  const corrected = callAgentTool(app, 'correct_user_fact', {
    factId: original.fact.id,
    action: 'replace',
    value: 'TypeScript',
    sourceText: '现在改为 TypeScript'
  });
  const history = callAgentTool(app, 'search_user_context', {
    query: 'JavaScript',
    includeHistorical: true
  });

  assert.equal(corrected.fact.object, 'TypeScript');
  assert.equal(corrected.replacedFact.id, original.fact.id);
  assert.equal(history.facts[0].sourceEpisode.body, '我偏好 JavaScript');
  assert.equal(history.facts[0].replacementFact.id, corrected.fact.id);
  assert.equal(history.facts[0].correctionEpisodes[0].metadata.action, 'replace');
  assertNoAdapterInternals(history);
});

test('search_user_context returns current source-backed Personal Lens data', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  app.bootstrap();
  const remembered = callAgentTool(app, 'remember_user_fact', {
    predicate: 'prefers_runtime',
    value: 'Node.js',
    sourceText: '我偏好 Node.js'
  });

  const result = callAgentTool(app, 'search_user_context', { query: 'Node.js' });

  assert.equal(result.facts[0].fact.id, remembered.fact.id);
  assert.equal(result.facts[0].sourceEpisode.id, remembered.episode.id);
  assert.equal(result.facts[0].sourceEpisode.body, '我偏好 Node.js');
});

test('Personal Lens tools reject an empty explicit personalSpaceId instead of falling back', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  app.bootstrap();

  assert.throws(() => callAgentTool(app, 'remember_user_fact', {
    personalSpaceId: '',
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我偏好 JavaScript'
  }), /Personal space not found/);
  assert.equal(store.listEpisodes().length, 0);
});

test('Personal Lens tools reject secrets without writing to FileStore', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  app.bootstrap();
  const before = store.exportSnapshot();

  assert.throws(() => callAgentTool(app, 'remember_user_fact', {
    predicate: 'credential',
    value: 'sk-live-12345678901234567890',
    sourceText: '记住这个凭据'
  }), /sensitive content/i);
  assert.deepEqual(store.exportSnapshot(), before);
});

test('existing agent reads run through the application facade on SQLite', () => {
  const store = new SqliteStore(':memory:');
  const app = createApplication({ store });
  const { personal, space } = app.bootstrap();
  callAgentTool(app, 'remember_episode', {
    personalSpaceId: personal.id,
    targetSpaceId: space.id,
    sourceKind: 'prd',
    sourceUri: 'prd://sqlite',
    body: 'api_base: https://sqlite.example.com'
  });

  const result = callAgentTool(app, 'get_current_facts', { spaceId: space.id });

  assert.equal(result.facts[0].object, 'https://sqlite.example.com');
  assertNoAdapterInternals(result);
  app.close();
});

const applications = new WeakMap();

function appFor(store) {
  if (!applications.has(store)) {
    applications.set(store, createApplication({ store, activePersonalSpaceName: 'Jevons' }));
  }
  return applications.get(store);
}

function assertNoAdapterInternals(value) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /"store"\s*:/);
  assert.doesNotMatch(json, /"databasePath"\s*:/);
  assert.doesNotMatch(json, /"snapshot"\s*:/);
}
