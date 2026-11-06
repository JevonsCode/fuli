import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planTaskKnowledgeRecall,
  recallTaskKnowledge,
  withRecoveredSource
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

test('rec#88: a task with no cue is searched by its own words, and a bare continue is not searched', () => {
  const plan = planTaskKnowledgeRecall('把数组按数字从小到大排序');
  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.trigger_categories, ['topic']);
  assert.ok(plan.queries.length >= 1);
  for (const bare of ['继续', 'ok']) assert.equal(planTaskKnowledgeRecall(bare).status, 'not_needed', bare);
});

test('model token usage does not recall authentication methods', () => {
  for (const prompt of ['检查 Token 消耗成本，减少工具 Schema tokens',
    'Measure input token usage and cache token cost', '优化 Token P0']) {
    assert.deepEqual(planTaskKnowledgeRecall(prompt).trigger_categories.filter(category => category !== 'topic'), [], prompt);
  }
  assert.ok(planTaskKnowledgeRecall('How do I configure an access token for login?')
    .trigger_categories.includes('access_authentication'));
});

test('negated delivery instructions do not recall a release runbook', () => {
  for (const prompt of ['优化性能，不提交、不发布、不推送到 GitHub。',
    '禁止提交代码，暂不部署。', 'Do not commit or publish this change.',
    '分析工具成本，不要发版和上线']) {
    assert.equal(planTaskKnowledgeRecall(prompt).trigger_categories.includes('release_delivery'), false, prompt);
  }
  assert.ok(planTaskKnowledgeRecall('不要提交代码，但需要部署测试版本')
    .trigger_categories.includes('release_delivery'));
  assert.ok(planTaskKnowledgeRecall('无需确认直接发布')
    .trigger_categories.includes('release_delivery'));
  assert.ok(planTaskKnowledgeRecall('不要过度封装并部署到测试环境')
    .trigger_categories.includes('release_delivery'));
  assert.ok(planTaskKnowledgeRecall('先不要发布。测试通过后发布新版本。')
    .trigger_categories.includes('release_delivery'));
});

test('comma-separated negated actions and relative where do not trigger recall', () => {
  for (const prompt of ['Do not commit, push, or create branches', 'Do not commit, push or deploy',
    'WSL Ubuntu, where `node` is installed']) {
    assert.deepEqual(planTaskKnowledgeRecall(prompt).trigger_categories.filter(category => category !== 'topic'), [], prompt);
  }
  for (const prompt of ['Where is the deploy runbook?', 'Can you find where config.json is loaded?',
    'Find where config.json is loaded', 'Show me where the API handler is defined.',
    "I'm not sure where the backup files are stored.", 'ok where is the config file',
    'Tell me, where is the config file', 'In WSL, where should node be installed']) {
    assert.ok(planTaskKnowledgeRecall(prompt).trigger_categories.includes('artifact_location'), prompt);
  }
  for (const prompt of ['push this to production', "Don't push, deploy to staging instead",
    'Never commit, ship it after review', 'Do not push to GitHub, and deploy to staging',
    '不要推送, 部署到测试环境', '不要提交,发布到 npm', "Don't push, deploy to staging or production",
    "Don't commit, push it when ready, or ask me first"]) {
    assert.ok(planTaskKnowledgeRecall(prompt).trigger_categories.includes('release_delivery'), prompt);
  }
});

test('self-contained workflow optimization does not trigger generic runbook recall', () => {
  const prompt = '分析并优化 Analytics Dashboard Builder 的搭建、局部修改与询问速度和流程，测试 model-k3 可行性；禁止提交代码。';
  const plan = planTaskKnowledgeRecall(prompt);

  assert.deepEqual(plan.trigger_categories, ['topic'], 'no runbook intent; only its own words');
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

test('a recall that ran no search carries no marker, and only a searched miss says 已检索，未命中', async () => {
  let calls = 0;
  const application = {
    config: { personal: { spaceId: 'personal-space' } },
    consoleUrl: 'http://127.0.0.1:2727',
    async searchKnowledge() { calls += 1; return { facts: [], entities: [] }; }
  };
  // A search by the prompt's own words that found nothing reads as no search (rec#88).
  const notSearched = await recallTaskKnowledge(application, { personalProjectId: 'fuli' }, 'Rename the parser variable.');
  assert.equal(notSearched.status, 'not_needed');
  calls = 0;
  assert.equal('sourceMarker' in notSearched, false);
  assert.equal('noMatchSourceMarker' in notSearched, false);
  assert.match(notSearched.guidance.candidate_selection, /without markers ran no search: show no marker/);

  const missed = await recallTaskKnowledge(application, { personalProjectId: 'fuli' }, 'Use the release method we decided previously.');
  assert.equal(missed.status, 'no_match');
  assert.ok(calls > 0);
  assert.match(missed.noMatchSourceMarker.leadMarkdown, /已检索，未命中/);
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

function recallApplication(entities, calls = []) {
  return {
    config: { personal: { spaceId: 'personal-space' } },
    consoleUrl: 'http://127.0.0.1:2727',
    async searchKnowledge(input) { calls.push(input); return { facts: [], entities }; }
  };
}
const ledgerNote = (id, confirmation_status, score) => ({ id, space_id: 'personal-space', scope: 'personal',
  name: 'Delta Ledger amounts', type: 'ProjectFact', summary: `Amounts are stored in cents (${id}).`,
  defined_project_id: 'delta', scope_distance: 0, confirmation_status, score });

test('prior-context recall carries an agent-proposed pending note when nothing confirmed matched',
  async () => {
    const calls = [];
    const recall = await recallTaskKnowledge(recallApplication([ledgerNote('pending-note', 'pending', 5)], calls),
      { personalProjectId: 'delta' }, 'Use the amount format we decided previously for Delta Ledger.');
    assert.equal(recall.status, 'matched');
    assert.equal(recall.entities[0].id, 'pending-note');
    assert.equal(recall.entities[0].confirmation_status, 'pending');
    assert.deepEqual(recall.pending_fallback.slots, ['entities']);
    assert.match(recall.pending_fallback.note, /not confirmed by a person/);
    assert.ok(calls.length > 0 && calls.every((call) => call.includePending === true));
  });

test('confirmed matches keep pending items out of the automatic recall', async () => {
  const recall = await recallTaskKnowledge(recallApplication([
    ledgerNote('pending-note', 'pending', 50), ledgerNote('agent-note', 'agent_confirmed', 1),
    ledgerNote('human-note', 'confirmed', 2)
  ]), { personalProjectId: 'delta' }, 'Use the amount format we decided previously for Delta Ledger.');
  assert.deepEqual(recall.entities.map(({ id }) => id).sort(), ['agent-note', 'human-note']);
  assert.equal('pending_fallback' in recall, false);
});

test('a recovered checkpoint gets its own source marker when recall found nothing', () => {
  const recall = { status: 'no_match', sourceMarker: { status: 'no_match' }, noMatchSourceMarker: { status: 'no_match' }, facts: [], entities: [] };
  const conversation = { recovery: { latest_checkpoint: { status: 'incomplete', summary: 'Plan decided; parser not written.' } } };
  const marked = withRecoveredSource(recall, conversation, { consoleUrl: 'http://127.0.0.1:2727', spaceId: 'space', agentId: 'lead' });
  assert.equal(marked.sourceMarker.status, 'recovered');
  assert.match(marked.sourceMarker.leadMarkdown, /接续上次进度\]\(http:\/\/127\.0\.0\.1:2727\/agents\/space\/lead\)/);
  assert.equal(marked.noMatchSourceMarker.status, 'no_match');
  assert.equal(withRecoveredSource({ ...recall, status: 'matched' }, conversation, { spaceId: 'space', agentId: 'lead' }).sourceMarker.status, 'no_match');
  assert.equal(withRecoveredSource(recall, { recovery: null }, { spaceId: 'space', agentId: 'lead' }), recall);
});

test('a prior-context prompt keeps the named target when it also quotes search parameters', () => {
  const prompt = 'Use the prior Cobalt rollout note and answer with region, shard and rollback window as JSON. '
    + 'If the note is not in context, call search_knowledge_graph with {"personalSpaceId": "4f0c2a3e-1b2c-4d5e-8f90-123456789abc", '
    + '"personalProjectId": "sample-project", "includePending": true}.';
  const plan = planTaskKnowledgeRecall(prompt);
  assert.ok(plan.trigger_categories.includes('prior_context'), plan.trigger_categories.join());
  assert.ok(plan.queries.every((query) => query.includes('Cobalt')), plan.queries.join(' | '));
  assert.ok(plan.queries.every((query) => !/personalSpaceId|4f0c2a3e|personalProjectId/.test(query)), plan.queries.join(' | '));
});

test('a question about several things gets one short query per clause before the category queries', () => {
  const plan = planTaskKnowledgeRecall('For this repo, answer in three short bullets: the release branch naming rule, '
    + 'the staging deploy command, and who must review payments code.');
  assert.deepEqual(plan.trigger_categories, ['release_delivery']);
  assert.deepEqual(plan.queries.slice(0, 3), ['release branch naming rule', 'staging deploy command', 'must review payments code']);
  assert.match(plan.queries[3], /release publish runbook/);
  assert.equal(plan.queries.length, 4);
});

test('Chinese release requests keep their focused category queries', () => {
  assert.deepEqual(planTaskKnowledgeRecall('检查一下代码，有问题暂停和我讨论，没问题发布一个新版本 0.7.0').queries,
    ['0.7.0 发布 发版 版本 release publish runbook', '0.7.0 推送 提交 push commit GitHub Connector runbook']);
});

test('recall tells the host to answer from items people confirmed, and only then', async () => {
  const human = await recallTaskKnowledge(recallApplication([ledgerNote('human-note', 'confirmed', 2)]),
    { personalProjectId: 'delta' }, 'Use the amount format we decided previously for Delta Ledger.');
  assert.match(human.confirmed_use, /answer from them directly/);
  for (const status of ['agent_confirmed', 'pending']) {
    const recall = await recallTaskKnowledge(recallApplication([ledgerNote('note', status, 2)]),
      { personalProjectId: 'delta' }, 'Use the amount format we decided previously for Delta Ledger.');
    assert.equal('confirmed_use' in recall, false, status);
  }
});

test('a person who wants every answer checked against the files gets no confirmed-use note', async () => {
  const app = { ...recallApplication([ledgerNote('human-note', 'confirmed', 2)]),
    getRecallPolicy: () => ({ answerFromConfirmed: false, updatedAt: null }) };
  const recall = await recallTaskKnowledge(app, { personalProjectId: 'delta' },
    'Use the amount format we decided previously for Delta Ledger.');
  assert.equal(recall.status, 'matched');
  assert.equal('confirmed_use' in recall, false);
});

// rec#63: facts are stored under their concept; queries of file paths and
// category words found none of them, and "no match" stopped the search.
test('a change request full of file paths still queries the fact it names by concept', () => {
  const plan = planTaskKnowledgeRecall('Make `fetchRate` in `src/rates.js` retry failed requests following the retry '
    + 'policy we agreed for the rates client. Keep the signature, so tests do not wait. Add tests to `test/rates.test.js`.');
  assert.equal(plan.status, 'planned');
  assert.equal(plan.queries[0], 'retry failed requests policy agreed');
  assert.ok(plan.queries.every((query) => !/tests do not wait|not wait/.test(query)), plan.queries.join(' | '));
});

test('a convention, an owner or "the way we" do something is a recall intent of its own', () => {
  const owner = planTaskKnowledgeRecall('Add the CODEOWNERS entry for `src/ledger/` naming the team that owns the ledger code.');
  assert.deepEqual(owner.trigger_categories, ['project_convention']);
  assert.equal(owner.queries[0], 'codeowners naming team owns ledger');
  assert.deepEqual(planTaskKnowledgeRecall('Add a `NegativeAmountError` following our error code convention.').queries[0],
    'error code convention');
  assert.equal(planTaskKnowledgeRecall('按我们约定的重试策略改一下 fetchRate').queries[0], '按约定重试策略改 fetchrate');
});

test('a search that found nothing says it was one quick search, not the whole store', async () => {
  const recall = await recallTaskKnowledge(recallApplication([]), { personalProjectId: 'delta' },
    'Use the retry policy we agreed for the rates client.');
  assert.equal(recall.status, 'no_match');
  assert.match(recall.next, /search_current_project_knowledge/);
  const found = await recallTaskKnowledge(recallApplication([ledgerNote('n', 'confirmed', 2)]), { personalProjectId: 'delta' },
    'Use the amount format we decided previously for Delta Ledger.');
  assert.equal(found.next, undefined);
});

test('trailing environment notes neither hide the prompt\'s own clauses nor take the focus slots (rec#63)', () => {
  const task = 'Make `fetchRate` in `src/rates.js` retry failed requests following the retry policy we agreed for the rates client.';
  const notes = 'Environment: you are running in WSL Ubuntu, where `node` is not installed; use the Windows Node 24 that is on PATH '
    + 'as `node.exe` (for example `node.exe --test test/rates.test.js`). Do not commit, push, or create branches.';
  const alone = planTaskKnowledgeRecall(task);
  const withNotes = planTaskKnowledgeRecall(`${task}\n\n${notes}`);
  assert.equal(withNotes.queries[0], alone.queries[0]);
  assert.match(withNotes.queries[0], /retry/);
  assert.ok(withNotes.queries.every((query) => !/WSL|Ubuntu|Windows/.test(query)), JSON.stringify(withNotes.queries));
});

test('a named target leaves room for the clause that names a kept fact (compounding eval)', () => {
  // "SMS" is a named target; the retry behaviour is the fact the task needs.
  const sms = planTaskKnowledgeRecall('SMS messages get dropped whenever the provider has a hiccup. Give the SMS channel the '
    + 'same retry behaviour we use for email, with tests, and make sure the whole suite passes.');
  assert.match(sms.queries[0], /^SMS .*convention policy rule owner$/);
  assert.ok(sms.queries.some((query) => /^SMS .*\bretry\b/.test(query)), sms.queries.join(' | '));
  assert.ok(sms.queries.every((query) => query.startsWith('SMS ')), 'every query keeps the target');
  // A named target with no clause naming a kept fact plans as before.
  const workflow = planTaskKnowledgeRecall('Analytics Dashboard Builder 应该按什么流程搭建？').queries;
  assert.equal(workflow.length, 1);
  assert.match(workflow[0], /方法 方式 流程 步骤 runbook workflow procedure$/);
});

test('a project that has stored nothing yet is not sent on a follow-up search; any doubt keeps the nudge (rec#88)', async () => {
  const profile = [{ type: 'PersonalProject' }, { type: 'ProjectPurpose' }, { type: 'ProjectScope' },
    { type: 'TechnicalSummary' }, { type: 'ProjectBoundary' }];
  const withGraph = graph => ({ ...recallApplication([]), personal: { async graph(space, limit, project) {
    assert.deepEqual([space, project], ['personal-space', 'delta']);
    assert.ok(limit <= 50);
    if (graph instanceof Error) throw graph;
    return graph;
  } } });
  const prompt = 'Use the retry policy we agreed for the rates client.';
  const next = async graph => (await recallTaskKnowledge(withGraph(graph), { personalProjectId: 'delta' }, prompt)).next;
  assert.match(await next({ nodes: profile, edges: [], truncated: false }), /no stored knowledge yet; no further FULI search/);
  for (const graph of [
    { nodes: [...profile, { type: 'ProjectFact' }], edges: [] },
    { nodes: profile, edges: [], truncated: true },
    { nodes: profile, edges: [{ type: 'PART_OF' }] },
    new Error('provider down')
  ]) assert.match(await next(graph), /One quick search only/);
  // A historical version alone is nothing a default search returns.
  assert.match(await next({ nodes: [...profile, { type: 'ProjectFact', invalid_at: '2026-01-01T00:00:00Z' }], edges: [] }),
    /no stored knowledge yet/);
});

test('a pending rule is sent whole only to a task its head names; otherwise it waits as a title (rec#88)', async () => {
  const policy = 'Our retry policy for every outbound channel: at most 3 attempts in total, waiting 200 ms before the second '
    + 'attempt and 400 ms before the third; retry only when the provider answers 5xx, never retry a 4xx.';
  const pending = { id: 'p-1', space_id: 'personal-space', scope: 'personal', name: policy.slice(0, 120), type: 'ProjectFact',
    summary: policy, defined_project_id: 'tidewater', scope_distance: 0, confirmation_status: 'pending', score: 0.2 };
  const recall = prompt => recallTaskKnowledge(recallApplication([pending]), { personalProjectId: 'tidewater' }, prompt);
  for (const prompt of [
    'SMS messages get dropped whenever the provider has a hiccup. Give the SMS channel the same retry behaviour we use for email.',
    'Add a webhook channel: it POSTs the message to `message.url` and uses our standard retry policy. Follow our conventions.',
    'A partner complained that our webhook retries hammered them after 4xx answers. Check every channel follows our retry policy.'
  ]) {
    const whole = await recall(prompt);
    assert.equal(whole.status, 'matched', prompt);
    assert.equal(whole.entities[0].id, 'p-1');
  }
  for (const prompt of [
    'Add `GET /healthz` to the server: it answers 200 with JSON listing the registered channel names. Follow our conventions.',
    'Sending a message to a channel we do not have crashes the relay. Make it fail with an error that follows our error-code conventions.'
  ]) {
    const titled = await recall(prompt);
    assert.equal(titled.status, 'indexed', prompt);
    assert.deepEqual(titled.entities, []);
    assert.equal(titled.knowledge_index.items[0][0], 'p-1');
    assert.ok(titled.knowledge_index.items[0][1].length <= 41);
  }
  // A confirmed item is never held back by this rule.
  const confirmed = await recallTaskKnowledge(recallApplication([{ ...pending, confirmation_status: 'confirmed' }]),
    { personalProjectId: 'tidewater' }, 'Add `GET /healthz` to the server listing the registered channel names. Follow our conventions.');
  assert.equal(confirmed.status, 'matched');
});

test('the pending relevance rule reads Chinese by character pairs (rec#88)', async () => {
  const rule = { id: 'p-zh', name: '我们的重试策略：最多 3 次，间隔 200 和 400 毫秒。', type: 'ProjectFact',
    summary: '我们的重试策略：最多 3 次，间隔 200 和 400 毫秒。', defined_project_id: 'tidewater', confirmation_status: 'pending' };
  const recall = prompt => recallTaskKnowledge(recallApplication([rule]), { personalProjectId: 'tidewater' }, prompt);
  assert.equal((await recall('短信渠道也按我们的重试策略来，补上测试。')).status, 'matched');
  assert.equal((await recall('按我们的约定加一个健康检查接口。')).status, 'indexed');
});
