// rec#146 item 1: a roundtable test message from a month earlier was still
// announced at every task entry as one other Agents were waiting on, although
// its recipient had read and answered it in its chat; and the same block told
// the Agent both to use reply_agent_message and (in the message body) not to
// call other communication tools. Synthetic store only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { chatWakeOf, chatWakePrompt } from '../packages/roundtable/src/roundtable/chat-snapshot.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';
import { AGENT_MESSAGES_GUIDANCE } from '../src/graphiti/task-entry-preferences.js';

const SPACE = 'synthetic-space';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-23T00:00:00Z');

// A roundtable over a store whose clock the test moves, so a question can be
// written at a chosen age without waiting for one.
function fixture() {
  let at = NOW;
  const store = createRoundtableStore(':memory:', { clock: () => new Date(at) });
  const app = {
    config: { personal: { spaceId: SPACE } },
    listProjectAgents: async () => [],
    taskContextRegistry: { context: async () => null },
    standingAssignments: createStandingAssignments(),
    personal: { recentAgentSessions: async () => [], listPersonalProjects: async () => [] }
  };
  const roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), openStore: () => store, now: () => at });
  const ask = (daysAgo, id, body = `SYNTHETIC question ${id}`) => {
    const threadId = `thread-${id}`;
    at = NOW - daysAgo * DAY_MS;
    store.createThread({ id: threadId, spaceId: SPACE, subject: 'synthetic', projectId: 'synthetic-project' });
    store.appendMessage(threadId, { id, kind: 'ask', body, status: 'queued',
      from: { agentId: 'sender-1', name: 'Synthetic Sender', client: 'codex' },
      to: { agentId: 'lead-1', name: 'Synthetic Lead', client: 'claude_code' }, targetProjectId: 'synthetic-project' });
    at = NOW;
  };
  const later = ms => { at += ms; };
  return { roundtable, ask, store, later };
}

// A chat wake's ask as chat-wake.js writes it, for a chat whose last shown message is seq 2.
const wakeBody = chatId => chatWakePrompt({ chatId, after: 0, earlierUnshown: false, nextAfter: 2, hasMore: false, unshown: false,
  messages: [{ seq: 1, from: 'local:sender-1', body: 'SYNTHETIC ping' }, { seq: 2, from: 'local:sender-1', body: 'SYNTHETIC ping 2' }] });

test('a chat wake already read and answered in its chat is no longer announced, whatever its age', () => {
  const { roundtable, ask, store } = fixture();
  const chatId = 'synthetic-chat';
  ask(1, 'wake-1', wakeBody(chatId));
  // Not read yet: it still waits.
  assert.deepEqual(roundtable.pending('lead-1', 'synthetic-project', null).map(item => item.messageId), ['wake-1']);
  // The recipient read the chat through seq 2 — the state the real record was in for 27 days.
  store.chat.markRead(chatId, 'local:lead-1', 2);
  roundtable.settleStaleAsks({ force: true });
  assert.deepEqual(roundtable.pending('lead-1', 'synthetic-project', null), []);
  // Settled, not deleted: the ask is answered through its chat.
  assert.deepEqual([store.getMessage('wake-1').status, store.getMessage('wake-1').via], ['answered', 'chat:read']);
});

test('a chat wake read only part of the way still waits', () => {
  const { roundtable, ask, store } = fixture();
  ask(1, 'wake-1', wakeBody('synthetic-chat'));
  store.chat.markRead('synthetic-chat', 'local:lead-1', 1);
  roundtable.settleStaleAsks({ force: true });
  assert.equal(store.getMessage('wake-1').status, 'queued');
  assert.equal(roundtable.pending('lead-1', 'synthetic-project', null).length, 1);
});

test('a queued question older than a week is expired, kept, and never announced again', () => {
  const { roundtable, ask, store } = fixture();
  ask(27, 'old-1');
  ask(1, 'fresh-1');
  assert.deepEqual(roundtable.pending('lead-1', 'synthetic-project', null).map(item => item.messageId), ['fresh-1']);
  const old = store.getMessage('old-1');
  assert.deepEqual([old.status, old.error], ['expired', 'unanswered_7_days']);
  assert.equal(old.body, 'SYNTHETIC question old-1', 'the history stays');
  assert.equal(store.getMessage('fresh-1').status, 'queued');
});

test('an old question never takes one of the five slots from a live one, even before it is expired', () => {
  const { roundtable, ask, store } = fixture();
  for (let index = 0; index < 5; index++) ask(30 + index, `old-${index}`);
  for (let index = 0; index < 5; index++) ask(index, `fresh-${index}`);
  // The window alone, without the sweep.
  const listed = store.pendingFor(SPACE, 'lead-1', 5, null, { since: new Date(NOW - 7 * DAY_MS).toISOString() });
  assert.deepEqual(listed.map(row => row.id).filter(id => id.startsWith('old-')), []);
  assert.equal(roundtable.pending('lead-1', 'synthetic-project', null).length, 5);
});

test('a question a wake is still running for is never expired under it', () => {
  const { roundtable, ask, store } = fixture();
  ask(10, 'running-1');
  assert.equal(store.claimExecution(SPACE, 'lead-1', 'running-1').claimed, true);
  roundtable.settleStaleAsks({ force: true });
  assert.equal(store.getMessage('running-1').status, 'queued');
});

test('a late reply still answers an expired question', async () => {
  const { roundtable, ask, store } = fixture();
  ask(27, 'old-1');
  roundtable.settleStaleAsks({ force: true });
  assert.equal(store.getMessage('old-1').status, 'expired');
  // replyMessage refuses only an already answered ask (service.js).
  assert.notEqual(store.getMessage('old-1').status, 'answered');
});

test('the settle runs at most once an hour unless forced', () => {
  const { roundtable, ask, later } = fixture();
  roundtable.settleStaleAsks({ force: true });
  ask(27, 'old-1');
  assert.deepEqual(roundtable.settleStaleAsks(), { answered: 0, expired: 0 }, 'inside the hour nothing runs');
  later(60 * 60 * 1000);
  assert.deepEqual(roundtable.settleStaleAsks(), { answered: 0, expired: 1 });
});

test('a chat wake body is read back exactly, and nothing else is taken for one', () => {
  assert.deepEqual(chatWakeOf(wakeBody('synthetic-chat')), { chatId: 'synthetic-chat', nextAfter: 2 });
  assert.equal(chatWakeOf('SYNTHETIC question'), null);
  assert.equal(chatWakeOf('FULI chat unread snapshot. but no json'), null);
  assert.equal(chatWakeOf(undefined), null);
});

test('the waiting guidance names one way to answer and says it outranks a message body', () => {
  assert.match(AGENT_MESSAGES_GUIDANCE, /reply_agent_message: that is the only way/);
  // The contradiction rec#146 reported: a body telling the Agent not to call
  // other communication tools no longer competes with this line.
  assert.match(AGENT_MESSAGES_GUIDANCE, /not to call a tool, follow this line instead/);
  assert.match(AGENT_MESSAGES_GUIDANCE, /sender's own\s+words, not a FULI rule/);
});
