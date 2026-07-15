import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyEpisode } from '../src/classifier.js';
import { extractFactSpecs } from '../src/extractor.js';
import { PublishRoute } from '../src/models.js';

test('PRD parameter is routed as a public fact', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'prd', body: 'test_url: https://test.example.com' }),
    PublishRoute.PUBLIC
  );
});

test('PRD natural forbidden rule is routed as a public fact', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'prd', body: '这个项目不要用 Redux' }),
    PublishRoute.PUBLIC
  );
});

test('personal preference stays personal', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'agent', body: '我觉得这个项目里我更喜欢先写原型' }),
    PublishRoute.PERSONAL
  );
});

test('first-person wish stays personal even when it looks like a fact', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'prd', body: '我希望 api_base: https://api.example.com' }),
    PublishRoute.PERSONAL
  );
});

test('first-person intent stays personal even when it looks like a fact', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'prd', body: '我想 api_base: https://api.example.com' }),
    PublishRoute.PERSONAL
  );
});

test('first-person plan stays personal even when it looks like a fact', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'prd', body: '我打算 api_base: https://api.example.com' }),
    PublishRoute.PERSONAL
  );
});

test('explicit personal source stays personal even for key value facts', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'personal', body: 'local_alias: pnpm dev' }),
    PublishRoute.PERSONAL
  );
});

test('uncertain work note becomes a quiet candidate', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'chat', body: '可能这个模块以后要拆出去' }),
    PublishRoute.CANDIDATE
  );
});

test('uncertain public-looking fact becomes a quiet candidate', () => {
  assert.equal(
    classifyEpisode({ sourceKind: 'prd', body: '可能 test_url: https://test.example.com' }),
    PublishRoute.CANDIDATE
  );
});

test('extracts key value fact', () => {
  const facts = extractFactSpecs('Project A', 'test_url: https://test.example.com');

  assert.equal(facts[0].kind, 'fact');
  assert.equal(facts[0].predicate, 'has_test_url');
  assert.equal(facts[0].object, 'https://test.example.com');
});

test('extracts Chinese key value fact', () => {
  const facts = extractFactSpecs('Project A', '测试地址：https://test.example.com');

  assert.equal(facts[0].kind, 'fact');
  assert.equal(facts[0].predicate, 'has_测试地址');
  assert.equal(facts[0].object, 'https://test.example.com');
});

test('extracts forbidden method fact', () => {
  const facts = extractFactSpecs('Project A', '禁止: 使用 Redux');

  assert.equal(facts[0].predicate, 'forbids');
  assert.equal(facts[0].object, '使用 Redux');
});

test('extracts natural forbidden method fact', () => {
  const facts = extractFactSpecs('Project A', '这个项目不要用 Redux');

  assert.equal(facts[0].predicate, 'forbids');
  assert.equal(facts[0].object, 'Redux');
});

test('extracts replacement spec', () => {
  const specs = extractFactSpecs('Project A', '替代: https://old.example.com => https://new.example.com');

  assert.equal(specs[0].kind, 'replacement');
  assert.equal(specs[0].oldValue, 'https://old.example.com');
  assert.equal(specs[0].newValue, 'https://new.example.com');
});
