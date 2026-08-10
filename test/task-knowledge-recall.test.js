import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planTaskKnowledgeRecall,
  recallTaskKnowledge
} from '../src/graphiti/task-knowledge-recall.js';

test('release requests produce focused recall queries instead of the full conversation', () => {
  const prompt = '检查一下代码，有问题暂停和我讨论，没问题发布一个新版本 0.7.0';
  const plan = planTaskKnowledgeRecall(prompt);

  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.trigger_categories, ['release_delivery']);
  assert.ok(plan.queries.some((query) => /发布.*release/i.test(query)));
  assert.ok(plan.queries.some((query) => /推送.*commit.*GitHub/i.test(query)));
  assert.equal(plan.queries.includes(prompt), false);
});

test('short follow-up push request still recalls the release runbook', () => {
  const plan = planTaskKnowledgeRecall('OK 你优化修复测试一下 然后再推');

  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.trigger_categories, ['release_delivery']);
  assert.ok(plan.queries.some((query) => /push.*commit/i.test(query)));
});

test('self-contained tasks without durable-context signals skip automatic recall', () => {
  const plan = planTaskKnowledgeRecall('把数组按数字从小到大排序');

  assert.deepEqual(plan, {
    status: 'not_needed',
    trigger_categories: [],
    queries: []
  });
});

test('self-contained workflow optimization does not trigger generic runbook recall', () => {
  const prompt = '分析并优化 Analytics Dashboard Builder 的搭建、局部修改与询问速度和流程，测试 model-k3 可行性；禁止提交代码。';
  const plan = planTaskKnowledgeRecall(prompt);

  assert.deepEqual(plan, {
    status: 'not_needed',
    trigger_categories: [],
    queries: []
  });
});

test('explicit workflow questions keep the named target in every recall query', () => {
  const plan = planTaskKnowledgeRecall(
    'Analytics Dashboard Builder 应该按什么流程搭建？'
  );

  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.trigger_categories, ['runbook_method']);
  assert.ok(plan.queries.length > 0);
  assert.ok(plan.queries.every((query) => /Analytics Dashboard Builder/i.test(query)));
});

test('synthetic credential fixtures suppress automatic prompt recall', async () => {
  const syntheticCredential = 'synthetic-credential-value';
  const prompt = `用之前的方法发布，token=${syntheticCredential}`;
  let calls = 0;
  const recall = await recallTaskKnowledge({
    config: { personal: { spaceId: 'personal-space' } },
    async searchKnowledge() { calls += 1; }
  }, { personalProjectId: 'fuli' }, prompt);

  assert.equal(recall.status, 'suppressed_sensitive');
  assert.equal(recall.query_count, 0);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(recall).includes(syntheticCredential), false);
});

test('automatic recall returns a compact exact-project runbook without echoing the prompt',
  async () => {
    const calls = [];
    const application = {
      config: { personal: { spaceId: 'personal-space' } },
      consoleUrl: 'http://127.0.0.1:2727',
      async searchKnowledge(input) {
        calls.push(input);
        if (!/推送/.test(input.query)) return { facts: [], entities: [] };
        return {
          facts: [{
            id: 'global-release-fact',
            space_id: 'personal-space',
            scope: 'personal',
            source_entity: 'Another project',
            target_entity: 'Release',
            fact: 'Unrelated global release fact.',
            defined_project_id: null,
            score: 9
          }],
          entities: [{
            id: 'release-validation',
            space_id: 'personal-space',
            scope: 'personal',
            name: 'Release recall validation',
            type: 'ValidationResult',
            summary: 'The release request recalled the runbook.',
            key: 'release-recall-validation',
            defined_project_id: 'fuli',
            scope_distance: 0,
            confirmation_status: 'confirmed',
            score: 12
          }, {
            id: 'fuli-submit-runbook',
            space_id: 'personal-space',
            scope: 'personal',
            name: 'FULI GitHub Connector 提交 Runbook',
            type: 'Runbook',
            summary: 'Use the connected GitHub Connector and never ask for local Git identity.',
            key: 'fuli-github-connector-submit-runbook',
            defined_project_id: 'fuli',
            scope_distance: 0,
            confirmation_status: 'confirmed',
            score: 1
          }]
        };
      }
    };
    const prompt = '检查一下代码，没问题发布一个新版本 0.7.0';

    const recall = await recallTaskKnowledge(
      application,
      { personalProjectId: 'fuli' },
      prompt
    );

    assert.equal(recall.status, 'matched');
    assert.equal(recall.entities[0].key, 'fuli-github-connector-submit-runbook');
    assert.match(recall.sourceMarker.leadMarkdown, /\/entity\/fuli-submit-runbook/);
    assert.equal(JSON.stringify(recall).includes(prompt), false);
    assert.ok(calls.every((call) => call.personalProjectId === 'fuli'));
    assert.ok(calls.every((call) => call.agentToolName ===
      'automatic_task_knowledge_recall'));
  });

test('automatic recall filters unrelated personal-global workflow matches by target',
  async () => {
    const application = {
      config: { personal: { spaceId: 'personal-space' } },
      consoleUrl: 'http://127.0.0.1:2727',
      async searchKnowledge() {
        return {
          facts: [{
            id: 'unrelated-workflow-failure',
            space_id: 'personal-space',
            scope: 'personal',
            source_entity: '旧数据接口持续重置连接',
            target_entity: 'Update Dataset workflow',
            relationship: 'AFFECTS',
            fact: '接口连接重置导致抓取步骤失败。',
            defined_project_id: null,
            score: 99
          }],
          entities: [{
            id: 'analytics-dashboard-runbook',
            space_id: 'personal-space',
            scope: 'personal',
            name: 'Analytics Dashboard Builder 搭建 Runbook',
            type: 'Runbook',
            summary: 'Build an analytics dashboard from a confirmed definition.',
            defined_project_id: null,
            score: 1
          }]
        };
      }
    };

    const recall = await recallTaskKnowledge(
      application,
      { personalProjectId: 'active-project' },
      'Analytics Dashboard Builder 应该按什么流程搭建？'
    );

    assert.equal(recall.status, 'matched');
    assert.deepEqual(recall.facts, []);
    assert.equal(recall.entities[0].id, 'analytics-dashboard-runbook');
    assert.match(recall.sourceMarker.leadMarkdown, /analytics-dashboard-runbook/);
    assert.doesNotMatch(recall.sourceMarker.markdown, /旧数据接口/);
  });

test('automatic recall failure stays non-blocking and does not claim a completed search',
  async () => {
    const prompt = '照旧使用之前的发布方法';
    const application = {
      config: { personal: { spaceId: 'personal-space' } },
      consoleUrl: 'http://127.0.0.1:2727',
      async searchKnowledge() {
        throw new Error('provider unavailable');
      }
    };

    const recall = await recallTaskKnowledge(
      application,
      { personalProjectId: 'fuli' },
      prompt
    );

    assert.equal(recall.status, 'unavailable');
    assert.equal(recall.partial, true);
    assert.equal(recall.failed_query_count, recall.query_count);
    assert.equal('sourceMarker' in recall, false);
    assert.equal('noMatchSourceMarker' in recall, false);
    assert.equal(JSON.stringify(recall).includes(prompt), false);
  });
