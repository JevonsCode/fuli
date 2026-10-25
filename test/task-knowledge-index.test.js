// rec#51 D-59: a coding task's entry gets a title-only index of the knowledge
// its exact project holds for it. Synthetic projects and items only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { recallTaskKnowledge } from '../src/graphiti/task-knowledge-recall.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { entryBudget, runWithEntryBudget } from '../src/conversations/entry-budget.js';

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
  assert.equal(recall.knowledge_index.matched, 8);
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
  assert.ok(Buffer.byteLength(text) < 520, `${Buffer.byteLength(text)} bytes with the read line`);
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

test('only a change request with a distinctive term searches for an index', async () => {
  const calls = [];
  const app = application({ facts: [], entities: [entity('rule', 'find_agents rule')] }, calls);
  for (const prompt of ['find_agents 是什么意思', 'fix the flaky test', '你好']) {
    assert.equal((await recallTaskKnowledge(app, { personalProjectId: PROJECT }, prompt)).status, 'not_needed', prompt);
  }
  assert.equal(calls.length, 0);
  assert.equal((await recallTaskKnowledge(app, { personalProjectId: PROJECT }, '修复 find_agents 的整词匹配')).status, 'indexed');
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
  const app = new FederatedGraphApplication({ version: 1, personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-token', principalId: 'synthetic-person', spaceId: 'personal-space' }, workspaces: [] }, {
    fetchImpl: async (rawUrl, options = {}) => {
      const { pathname } = new URL(rawUrl);
      const body = options.body ? JSON.parse(options.body) : null;
      if (pathname === '/v1/search') searches.push(body);
      const answer = pathname === '/v1/search'
        ? { facts: [], entities: body.project_agent_id === 'fla-owner' ? [shared, owned] : [shared] }
        : pathname === '/v1/knowledge/agent-views' ? { recorded_count: 1, item_keys: [] } : [];
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const recall = await recallTaskKnowledge(app, { personalProjectId: PROJECT }, PROMPT, { sourceApplication: 'opencode' });
  assert.equal(searches.length, 1);
  assert.equal(searches[0].project_agent_id ?? null, null);
  assert.deepEqual(recall.knowledge_index.items.map(([id]) => id), ['shared']);
  assert.equal(JSON.stringify(recall).includes('private FLA'), false);
});
