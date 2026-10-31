import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  acceptTopicProposal, declineTopicProposal, isProposable, listTopicProposals, proposalForTopic, topicOutcome,
  undoTopicPromotion
} from '../src/graphiti/topic-proposals.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

// Synthetic Provider boundary: stored topic counts, days and declines only.
function application(topics, { promotion } = {}) {
  const calls = [];
  const registered = new Map();
  return { config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2797', calls, registered,
    ...(promotion ? { topicPromotion: () => promotion } : {}),
    upsertPersonalProject: async input => {
      calls.push(['create', input]);
      registered.set(input.projectId, { project_id: input.projectId, scope_type: 'registered', profile: input.profile });
    },
    personal: {
      listPersonalProjects: async () => [...registered.values()],
      getPersonalProject: async (_, id) => registered.get(id),
      staffDefaultProjectLead: async input => { calls.push(['staff', input]);
        return { status: 'ready', agent: { agent_id: `lead-${input.personal_project_id}` } }; },
      conversationTriage: async (operation, input) => {
        calls.push([operation, input]);
        const key = value => value.trim().toLowerCase();
        if (operation === 'topics') return { topics: topics.filter(item => item.count >= input.min_count
          && (!input.topic || key(item.topic) === key(input.topic))).slice(0, input.limit) };
        if (operation === 'decline') return { topic: input.topic, declined_count: 4 };
        if (operation === 'reopen') return { topic: input.topic, personal_project_id: input.personal_project_id,
          conversation_ids: ['a', 'b', 'c'], declined_count: 4 };
        return { personal_project_id: input.personal_project_id, conversation_ids: ['a', 'b', 'c'] };
      }
    } };
}

const topic = (name, count, days, declined = null) => ({ topic: name, count, days, declined_count: declined });

test('a topic is proposed after three conversations over two days, and again three after a decline', () => {
  assert.equal(isProposable(topic('t', 3, 2)), true);
  assert.equal(isProposable(topic('t', 2, 2)), false, 'not often enough');
  assert.equal(isProposable(topic('t', 9, 1)), false, 'one busy day is not long-term');
  assert.equal(isProposable(topic('t', 5, 3, 3)), false);
  assert.equal(isProposable(topic('t', 6, 3, 3)), true);
});

test('the console lists only proposable topics', async () => {
  const app = application([topic('Garden', 4, 3), topic('Taxes', 3, 1), topic('Trips', 7, 4, 6)]);
  assert.deepEqual(await listTopicProposals(app), { proposals: [{ topic: 'Garden', conversations: 4, days: 3,
    last_labeled_at: null, declined_count: null }] });
  assert.equal(app.calls[0][1].min_count, 3);
});

test('the conversation that reaches the bar asks once every three conversations', async () => {
  const asked = await proposalForTopic(application([topic('Garden', 3, 2)]), 'garden');
  assert.equal(asked.console_url, 'http://127.0.0.1:2797/employees/assistant');
  assert.match(asked.ask_user, /「Garden」已经聊了 3 次、跨 2 天，还没成立项目/);
  assert.match(asked.guidance, /never form the project yourself/);
  assert.equal(await proposalForTopic(application([topic('Garden', 4, 2)]), 'garden'), null);
  assert.equal(await proposalForTopic(application([topic('Garden', 6, 2, 3)]), 'garden') !== null, true);
  assert.equal(await proposalForTopic(application([topic('Garden', 3, 1)]), 'garden'), null);
});

test('accepting forms a project, staffs a lead and attaches every conversation of the topic', async () => {
  const app = application([topic('Garden', 4, 3)]);
  const formed = await acceptTopicProposal(app, { topic: 'garden' });
  assert.deepEqual(formed, { status: 'formed', personal_project_id: 'garden', topic: 'Garden',
    reason: '你同意了 Astro 的建议：话题「Garden」累计 4 个会话、跨 3 天', created: true, lead_agent_id: 'lead-garden',
    lead_status: 'ready', conversations: 3 });
  const create = app.calls.find(([kind]) => kind === 'create')[1];
  assert.equal(create.createOnly, true);
  assert.match(create.profile.purpose, /AI 草稿/);
  assert.deepEqual(app.calls.map(([kind]) => kind), ['topics', 'create', 'staff', 'form']);
  assert.equal(app.calls.find(([kind]) => kind === 'staff')[1].source_application, 'other');
});

test('with topicPromotion auto a grown topic is formed at once and announced with its undo link (D-86)', async () => {
  const app = application([topic('Garden', 3, 2)], { promotion: 'auto' });
  const promoted = await topicOutcome(app, 'garden', { sourceApplication: 'codex' });
  assert.equal(promoted.status, 'promoted');
  assert.equal(promoted.personal_project_id, 'garden');
  assert.equal(promoted.created, true);
  assert.equal(promoted.notice, 'FULI：话题「Garden」聊了 3 次、跨 2 天，已升级为项目「Garden」。'
    + '[改名、换上级或撤销](<http://127.0.0.1:2797/employees/assistant?promoted=garden&topic=Garden>)');
  assert.match(promoted.guidance, /unchanged/);
  assert.match(app.calls.find(([kind]) => kind === 'create')[1].profile.purpose, /^Astro 自动升级：/);
  assert.equal(app.calls.find(([kind]) => kind === 'staff')[1].source_application, 'codex');
  // Not grown enough, or set to ask: nothing is formed.
  assert.equal(await topicOutcome(application([topic('Garden', 3, 1)], { promotion: 'auto' }), 'garden'), null);
  const asked = application([topic('Garden', 3, 2)], { promotion: 'ask' });
  assert.equal((await topicOutcome(asked, 'garden')).status, 'ask_user');
  assert.equal(asked.calls.some(([kind]) => kind === 'form'), false);
});

test('undo reopens the topic and archives only a project Astro created by itself', async () => {
  const app = application([topic('Garden', 3, 2)], { promotion: 'auto' });
  await topicOutcome(app, 'garden');
  const undone = await undoTopicPromotion(app, { topic: 'Garden', personalProjectId: 'garden' });
  assert.deepEqual(undone, { status: 'reopened', topic: 'Garden', personal_project_id: 'garden', conversations: 3,
    project_archived: true, ask_again_at: 7 });
  assert.equal(app.registered.get('garden').profile.lifecycle, 'archived');
  assert.deepEqual(app.calls.find(([kind]) => kind === 'reopen')[1],
    { personal_space_id: 'space', topic: 'Garden', personal_project_id: 'garden' });
  // A project the person already had keeps its lifecycle.
  const own = application([topic('Garden', 3, 2)]);
  own.registered.set('garden', { project_id: 'garden', profile: { name: 'Garden', purpose: 'Mine', lifecycle: 'active' } });
  assert.equal((await undoTopicPromotion(own, { topic: 'Garden', personalProjectId: 'garden' })).project_archived, false);
  assert.equal(own.registered.get('garden').profile.lifecycle, 'active');
  await assert.rejects(undoTopicPromotion(own, { topic: 'Garden' }), /topic and its project/);
});

test('declining remembers the count, and an unknown topic changes nothing', async () => {
  const app = application([topic('Garden', 4, 3)]);
  assert.deepEqual(await declineTopicProposal(app, { topic: 'Garden' }),
    { status: 'declined', topic: 'Garden', declined_count: 4, ask_again_at: 7 });
  await assert.rejects(acceptTopicProposal(app, { topic: 'Nothing' }), /No open conversation/);
  await assert.rejects(declineTopicProposal(app, { topic: ' ' }), /topic is required/);
  assert.deepEqual(app.calls.map(([kind]) => kind), ['topics', 'decline', 'topics']);
});

function call(method, path, body, app) {
  const request = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method, headers: { 'content-type': 'application/json' } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  return handleGraphApiRequest({ request, response, url: new URL(`http://127.0.0.1${path}`), app })
    .then(handled => ({ handled, ...sent }));
}

test('the console routes reach the owner operations', async () => {
  const received = [];
  const app = { topicProposals: async (operation, input) => { received.push([operation, input]); return { ok: true }; } };
  assert.equal((await call('GET', '/api/topic-proposals?personalSpaceId=space', null, app)).status, 200);
  await call('POST', '/api/topic-proposals/accept', { personalSpaceId: 'space', topic: 'Garden' }, app);
  await call('POST', '/api/topic-proposals/decline', { personalSpaceId: 'space', topic: 'Garden' }, app);
  await call('POST', '/api/topic-proposals/undo', { personalSpaceId: 'space', topic: 'Garden', personalProjectId: 'garden' }, app);
  assert.deepEqual(received, [['list', { personalSpaceId: 'space' }],
    ['accept', { personalSpaceId: 'space', topic: 'Garden' }], ['decline', { personalSpaceId: 'space', topic: 'Garden' }],
    ['undo', { personalSpaceId: 'space', topic: 'Garden', personalProjectId: 'garden' }]]);
  assert.equal((await call('DELETE', '/api/topic-proposals', null, app)).handled, false);
});
