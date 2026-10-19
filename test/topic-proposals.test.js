import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  acceptTopicProposal, declineTopicProposal, isProposable, listTopicProposals, proposalForTopic
} from '../src/graphiti/topic-proposals.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

// Synthetic Provider boundary: stored topic counts, days and declines only.
function application(topics) {
  const calls = [];
  const registered = new Map();
  return { config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2797', calls,
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
    reason: '你同意了 Astro 的建议：话题「Garden」累计 4 个会话、跨 3 天', lead_agent_id: 'lead-garden',
    lead_status: 'ready', conversations: 3 });
  const create = app.calls.find(([kind]) => kind === 'create')[1];
  assert.equal(create.createOnly, true);
  assert.match(create.profile.purpose, /AI 草稿/);
  assert.deepEqual(app.calls.map(([kind]) => kind), ['topics', 'create', 'staff', 'form']);
  assert.equal(app.calls.find(([kind]) => kind === 'staff')[1].source_application, 'other');
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
  assert.deepEqual(received, [['list', { personalSpaceId: 'space' }],
    ['accept', { personalSpaceId: 'space', topic: 'Garden' }], ['decline', { personalSpaceId: 'space', topic: 'Garden' }]]);
  assert.equal((await call('DELETE', '/api/topic-proposals', null, app)).handled, false);
});
