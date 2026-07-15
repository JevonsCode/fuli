import test from 'node:test';
import assert from 'node:assert/strict';

import { SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';
import { IngestionService } from '../src/ingestion.js';
import { ContextRouter } from '../src/router.js';

test('search context includes subscribed public spaces', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  const ingestion = new IngestionService(store);
  ingestion.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://test.example.com'
  });

  const router = new ContextRouter(store);
  const result = router.searchContext({ personalSpaceId: personal.id, query: 'test_url' });

  assert.match(result.answer, /https:\/\/test\.example\.com/);
  assert.match(result.answer, /Project A：test_url 是 https:\/\/test\.example\.com/);
  assert.doesNotMatch(result.answer, /Project A test_url https:\/\/test\.example\.com/);
  assert.doesNotMatch(result.answer, /has_test_url/);
  assert.equal(result.facts[0].spaceId, project.id);
});

test('search context defaults to current facts only', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  const ingestion = new IngestionService(store);
  ingestion.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'test_url: https://old.example.com'
  });
  ingestion.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: '替代: https://old.example.com => https://new.example.com'
  });

  const router = new ContextRouter(store);
  const result = router.searchContext({ personalSpaceId: personal.id, query: 'example.com' });

  assert.match(result.answer, /https:\/\/new\.example\.com/);
  assert.doesNotMatch(result.answer, /https:\/\/old\.example\.com/);
});

test('search context returns compact source-backed matches for agents', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  const ingestion = new IngestionService(store);
  ingestion.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    sourceUri: 'prd://project-a/v1',
    body: 'test_url: https://source.example.com'
  });

  const router = new ContextRouter(store);
  const result = router.searchContext({ personalSpaceId: personal.id, query: 'source.example' });

  assert.equal(result.matches[0].spaceName, 'Project A');
  assert.equal(result.matches[0].current, true);
  assert.equal(result.matches[0].fact.object, 'https://source.example.com');
  assert.deepEqual(result.matches[0].source, {
    id: result.matches[0].source.id,
    kind: 'prd',
    uri: 'prd://project-a/v1',
    body: 'test_url: https://source.example.com',
    createdAt: result.matches[0].source.createdAt
  });
});

test('search context returns a concise Chinese empty answer', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const router = new ContextRouter(store);

  const result = router.searchContext({ personalSpaceId: personal.id, query: 'missing' });

  assert.equal(result.answer, '没有找到相关当前事实');
});
