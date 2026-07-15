import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { createApplication } from '../src/app/create-application.js';
import { FactScope, FactStatus, Sensitivity, SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';

test('agent projections preserve authority and hide unconfirmed public facts', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  const personalSource = store.addEpisode(personal.id, 'conversation', 'personal evidence');
  addFact(store, personalSource.id, {
    id: 'personal-observed', spaceId: personal.id, predicate: 'prefers_modules',
    object: 'small', status: FactStatus.OBSERVED
  });
  addFact(store, personalSource.id, {
    id: 'personal-suggested', spaceId: personal.id, predicate: 'prefers_output',
    object: 'concise', status: FactStatus.SUGGESTED
  });

  const oldSource = store.addEpisode(project.id, 'prd', 'runtime: Node 22');
  const newSource = store.addEpisode(project.id, 'prd', 'runtime: Node 24');
  const unconfirmedSource = store.addEpisode(project.id, 'observation', 'unconfirmed project claims');
  addFact(store, oldSource.id, {
    id: 'public-old', spaceId: project.id, subject: 'Project', predicate: 'has_runtime',
    object: 'Node 22', scope: FactScope.PUBLIC, validAt: '2026-07-10T00:00:00.000Z'
  });
  addFact(store, newSource.id, {
    id: 'public-confirmed', spaceId: project.id, subject: 'Project', predicate: 'has_runtime',
    object: 'Node 24', scope: FactScope.PUBLIC, validAt: '2026-07-11T00:00:00.000Z'
  });
  store.updateFact('public-old', {
    invalidAt: '2026-07-11T00:00:00.000Z',
    replacedByFactId: 'public-confirmed'
  });
  addFact(store, unconfirmedSource.id, {
    id: 'public-observed', spaceId: project.id, subject: 'Project',
    predicate: 'has_observed_claim', object: 'maybe', scope: FactScope.PUBLIC,
    status: FactStatus.OBSERVED
  });
  addFact(store, unconfirmedSource.id, {
    id: 'public-suggested', spaceId: project.id, subject: 'Project',
    predicate: 'has_suggested_claim', object: 'perhaps', scope: FactScope.PUBLIC,
    status: FactStatus.SUGGESTED
  });

  const app = createApplication({ store, activePersonalSpaceName: personal.name });
  const search = callAgentTool(app, 'search_context', {
    personalSpaceId: personal.id,
    query: ''
  });
  const pack = callAgentTool(app, 'get_context_pack', {
    personalSpaceId: personal.id,
    spaceId: project.id,
    query: ''
  });
  const current = callAgentTool(app, 'get_current_facts', { spaceId: project.id });
  const runtimeHistory = pack.histories.find(({ predicate }) => predicate === 'has_runtime');

  assert.deepEqual({
    search: authorities(search.matches),
    pack: authorities(pack.matches),
    rules: authorities(pack.rules.parameters.map((fact) => ({ fact }))),
    history: runtimeHistory.facts.map(({ status }) => status),
    current: Object.fromEntries(current.facts.map(({ id, status }) => [id, status]))
  }, {
    search: {
      'personal-observed': FactStatus.OBSERVED,
      'personal-suggested': FactStatus.SUGGESTED,
      'public-confirmed': FactStatus.CONFIRMED
    },
    pack: {
      'personal-observed': FactStatus.OBSERVED,
      'public-confirmed': FactStatus.CONFIRMED
    },
    rules: { 'public-confirmed': FactStatus.CONFIRMED },
    history: [FactStatus.CONFIRMED, FactStatus.CONFIRMED],
    current: { 'public-confirmed': FactStatus.CONFIRMED }
  });

  app.close();
});

function authorities(matches) {
  return Object.fromEntries(matches
    .map(({ fact }) => [fact.id, fact.status])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function addFact(store, sourceEpisodeId, overrides) {
  return store.addFact({
    subject: 'user',
    sensitivity: Sensitivity.NORMAL,
    scope: FactScope.PERSONAL,
    status: FactStatus.CONFIRMED,
    sourceEpisodeId,
    ...overrides
  });
}
