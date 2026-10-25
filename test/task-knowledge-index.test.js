// rec#51 D-59: a coding task's entry gets a title-only index of the knowledge
// its exact project holds for it. Synthetic projects and items only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { recallTaskKnowledge } from '../src/graphiti/task-knowledge-recall.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { entryBudget, runWithEntryBudget } from '../src/conversations/entry-budget.js';
import { runWithAgentRequestContext } from '../src/app/agent-request-context.js';

const syntheticApplication = fetchImpl => new FederatedGraphApplication({ version: 1, personal: {
  providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-token', principalId: 'synthetic-person',
  spaceId: 'personal-space' }, workspaces: [] }, { fetchImpl });
const json = answer => new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });

const PROJECT = 'synthetic-project';
const PROMPT = 'Fix find_agents so terms match as whole words in packages/roundtable';
const BODY = 'SYNTHETIC BODY: match the stored term in both directions';

function entity(id, name, extra = {}) {
  return { id, space_id: 'personal-space', scope: 'personal', name, type: 'Rule', summary: `${BODY} (${id}).`,
    defined_project_id: PROJECT, scope_distance: 0, confirmation_status: 'confirmed', score: 1, ...extra };
}

function application(found, calls = []) {
  return {
    config: { personal: { spaceId: 'personal-space' } },
    consoleUrl: 'http://127.0.0.1:2727',
    async searchKnowledge(input) {
      calls.push(input);
      if (found instanceof Error) throw found;
      return found;
    }
  };
}

const NOT_NEEDED = async prompt => JSON.stringify(await recallTaskKnowledge(application({ facts: [], entities: [] }),
  { personalProjectId: PROJECT }, prompt));

test('a coding prompt gets at most five exact-project titles with ids and the match count, never a body', async () => {
  const calls = [];
  const items = Array.from({ length: 7 }, (_, index) => entity(`00000000-0000-4000-8000-00000000000${index + 1}`,
    `find_agents rule ${index + 1}: ${'whole-word term matching '.repeat(4)}`));
  const found = { facts: [{ id: '00000000-0000-4000-8000-0000000000f1', space_id: 'personal-space', scope: 'personal', source_entity: 'find_agents',
    target_entity: 'termOccurs', relationship: 'USES', fact: `${BODY} (fact).`, defined_project_id: PROJECT,
    scope_distance: 0, confirmation_status: 'confirmed', score: 2 }],
  entities: [...items,
    entity('inherited', 'find_agents parent rule', { inherited_from_project_id: 'parent', scope_distance: 1 }),
    entity('global', 'find_agents global rule', { defined_project_id: null }),
    entity('other-project', 'find_agents rule elsewhere', { defined_project_id: 'other' }),
    entity('unrelated', 'Release checklist'),
    entity('preference', 'find_agents style', { profile_aspect: 'taste' })] };
  const recall = await recallTaskKnowledge(application(found, calls), { personalProjectId: PROJECT }, PROMPT,
    { sourceApplication: 'opencode', sessionId: 'synthetic-session' });

  assert.equal(recall.status, 'indexed');
  assert.equal(recall.knowledge_index.matched_in_search, 8, 'what this one search kept, not a project total');
  assert.equal(recall.knowledge_index.items.length, 5);
  for (const item of recall.knowledge_index.items) assert.equal(item.length, 2, 'an [id, title] pair');
  assert.deepEqual(recall.knowledge_index.items[0], ['00000000-0000-4000-8000-0000000000f1', 'find_agents → termOccurs'],
    'ranked by the recall order: the higher score first');
  assert.ok(recall.knowledge_index.items.every(([, title]) => Buffer.byteLength(JSON.stringify(title)) <= 40));
  assert.ok(recall.knowledge_index.items.slice(1).every(([, title]) => title.endsWith('…')), 'long titles are cut');
  assert.match(recall.knowledge_index.read, /search_current_project_knowledge/);
  // The worst case: five UUIDs and every title but one cut at its limit.
  const { read: _read, ...index } = recall.knowledge_index;
  assert.ok(Buffer.byteLength(JSON.stringify(index)) < 450, `${Buffer.byteLength(JSON.stringify(index))} bytes`);
  const text = JSON.stringify(recall.knowledge_index);
  // The read line says the titles come from one bounded search (#368 review): 108 bytes.
  assert.ok(Buffer.byteLength(text) < 560, `${Buffer.byteLength(text)} bytes with the read line`);
  for (const hidden of ['SYNTHETIC BODY', 'parent rule', 'global rule', 'rule elsewhere', 'Release checklist', 'find_agents style']) {
    assert.equal(JSON.stringify(recall).includes(hidden), false, hidden);
  }
  assert.deepEqual(recall.facts, []);
  assert.deepEqual(recall.entities, []);
  assert.equal(recall.sourceMarker, undefined, 'titles alone support no answer, so they need no source marker');
  assert.equal(JSON.stringify(recall).includes(PROMPT), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].personalProjectId, PROJECT);
  assert.equal(calls[0].projectAgentId, undefined, 'the recall\'s own reader: a plain session');
  assert.equal(calls[0].agentToolName, 'automatic_task_knowledge_index');
  assert.equal(calls[0].query.includes(PROMPT), false);
  assert.match(calls[0].query, /find_agents/);
});

test('with nothing relevant, no project, a failed search or too little time the recall is byte for byte as before', async () => {
  // A prompt that never searches is the recall as it was before the index.
  const before = await NOT_NEEDED('把数组按数字从小到大排序');
  const unrelated = { facts: [], entities: [entity('unrelated', 'Release checklist'),
    entity('global', 'find_agents global rule', { defined_project_id: null })] };
  const cases = [
    [application({ facts: [], entities: [] }), { personalProjectId: PROJECT }],
    [application(unrelated), { personalProjectId: PROJECT }],
    [application(new Error('synthetic Provider failure')), { personalProjectId: PROJECT }],
    [application({ facts: [], entities: [entity('rule', 'find_agents rule')] }), { personalProjectId: null }]
  ];
  for (const [app, resolution] of cases) {
    assert.equal(JSON.stringify(await recallTaskKnowledge(app, resolution, PROMPT)), before);
  }
  const calls = [];
  const late = entryBudget(1500);
  const recall = await runWithEntryBudget(late, () => recallTaskKnowledge(
    application({ facts: [], entities: [entity('rule', 'find_agents rule')] }, calls), { personalProjectId: PROJECT }, PROMPT));
  assert.equal(JSON.stringify(recall), before);
  assert.equal(calls.length, 0, 'with the entry\'s time low the index is not searched');
});

// The change-request heuristic: a clause that opens with a change verb.
const indexSearches = calls => calls.filter(({ agentToolName }) => agentToolName === 'automatic_task_knowledge_index');

test('explanations, questions, negations and change words used as nouns never search for an index', async () => {
  const calls = [];
  const app = application({ facts: [], entities: [entity('rule', 'find_agents rule')] }, calls);
  for (const prompt of [
    'find_agents 是什么意思', 'fix the flaky test', '你好',
    'Explain find_agents tests', 'find_agents 支持什么', 'What does find_agents test?',
    'Why does find_agents fix the term order?', 'Is find_agents fixed?', 'Does find_agents support partial words?',
    'Tests for find_agents are in packages/roundtable', 'Support for find_agents is planned',
    'The find_agents bugs are known', "Don't change find_agents", 'Do not refactor find_agents',
    'Never add tests to find_agents', '不要修改 find_agents', '别动 find_agents', '不用给 find_agents 补测试',
    'find_agents 的测试为什么失败？', 'find_agents 是否支持双向匹配', '你觉得 find_agents 需要重构吗'
  ]) {
    const recall = await recallTaskKnowledge(app, { personalProjectId: PROJECT }, prompt);
    assert.notEqual(recall.status, 'indexed', prompt);
    assert.equal(recall.knowledge_index, undefined, prompt);
  }
  assert.deepEqual(indexSearches(calls), []);
});

test('real change requests in English and Chinese do search for an index', async () => {
  for (const prompt of [
    PROMPT, 'Please add tests for find_agents', 'Can you refactor find_agents?',
    'Read packages/roundtable first, then update find_agents', 'Tests for find_agents fail; fix them in find_agents',
    'OK, now make find_agents match both directions', '修复 find_agents 的整词匹配', '给 find_agents 补测试',
    '把 find_agents 改成双向匹配', '请帮我重构 find_agents', '先看一下代码，然后优化 find_agents 的排序'
  ]) {
    const calls = [];
    const app = application({ facts: [], entities: [entity('rule', 'find_agents rule')] }, calls);
    const recall = await recallTaskKnowledge(app, { personalProjectId: PROJECT }, prompt);
    assert.equal(recall.status, 'indexed', prompt);
    assert.equal(indexSearches(calls).length, 1, prompt);
  }
});

test('a sensitive prompt is suppressed before any index search', async () => {
  const calls = [];
  const credential = 'synthetic-credential-value';
  const recall = await recallTaskKnowledge(application({ facts: [], entities: [entity('rule', 'find_agents rule')] }, calls),
    { personalProjectId: PROJECT }, `Fix find_agents login, token=${credential}`);
  assert.equal(recall.status, 'suppressed_sensitive');
  assert.equal(recall.knowledge_index, undefined);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(recall).includes(credential), false);
});

test('an FLA\'s own knowledge never reaches another reader\'s index', async () => {
  const searches = [];
  // The Provider double answers as knowledge_visibility.py does: an item an
  // FLA wrote only to that FLA reading in its project.
  const owned = entity('fla-private', 'find_agents private FLA note');
  const shared = entity('shared', 'find_agents shared rule');
  const app = syntheticApplication(async (rawUrl, options = {}) => {
    const { pathname } = new URL(rawUrl);
    const body = options.body ? JSON.parse(options.body) : null;
    if (pathname === '/v1/search') searches.push(body);
    return json(pathname === '/v1/search'
      ? { facts: [], entities: body.project_agent_id === 'fla-owner' ? [shared, owned] : [shared] }
      : pathname === '/v1/knowledge/agent-views' ? { recorded_count: 1, item_keys: [] } : []);
  });
  const recall = await recallTaskKnowledge(app, { personalProjectId: PROJECT }, PROMPT, { sourceApplication: 'opencode' });
  assert.equal(searches.length, 1);
  assert.equal(searches[0].project_agent_id ?? null, null);
  assert.deepEqual(recall.knowledge_index.items.map(([id]) => id), ['shared']);
  assert.equal(JSON.stringify(recall).includes('private FLA'), false);
});

test('2 s only gates the start: a search already running stops with the hook\'s abort and leaves the recall as before', async () => {
  const before = await NOT_NEEDED('把数组按数字从小到大排序');
  const started = Promise.withResolvers();
  let reason = null;
  // The Provider double answers only when its request is aborted, through
  // the signal the Provider client combines with its own timeout.
  const app = syntheticApplication(async (rawUrl, options = {}) => {
    if (new URL(rawUrl).pathname !== '/v1/search') return json([]);
    started.resolve();
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(reason = options.signal.reason), { once: true }));
  });
  const hook = new AbortController();
  const running = runWithAgentRequestContext({ signal: hook.signal },
    () => recallTaskKnowledge(app, { personalProjectId: PROJECT }, PROMPT));
  await started.promise;
  hook.abort(new Error('synthetic hook deadline'));
  assert.equal(JSON.stringify(await running), before);
  assert.equal(reason?.message, 'synthetic hook deadline', 'the hook\'s abort, not the Provider timeout, ended it');
});
