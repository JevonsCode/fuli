import assert from 'node:assert/strict';
import test from 'node:test';

import { roundtableTurn, withRoundtableReceipt } from '../src/agent-roundtable/turn-receipt.js';
import { RecallImpressionsStore, taskKeyFor } from '../src/knowledge-impressions/store.js';

// The receipt of a turn that used the roundtable. Synthetic Agents and
// threads; the task registry and the Provider are fakes.

function application({ ownerless = false, registryFails = false } = {}) {
  return { consoleUrl: 'http://127.0.0.1:3999', config: { personal: { spaceId: 'synthetic-space' } },
    taskContextRegistry: { context: async (token) => {
      if (registryFails) throw new Error('synthetic registry failure');
      return { token, personalProjectId: 'synthetic-project', projectAgentId: ownerless ? null : 'lead', sourceApplication: 'claude_code' };
    } },
    personal: { getProjectAgent: async () => ({ profile: { display_name: 'Alex Morgan', name: 'synthetic 负责人' } }) } };
}

const LEAD = '[Alex Morgan \\[synthetic 负责人\\]](http://127.0.0.1:3999/agents/synthetic-space/lead)';
const NOVA = '[Nova Reed](http://127.0.0.1:3999/agents/synthetic-space/reviewer)';
const THREAD = id => `[圆桌对话详情](http://127.0.0.1:3999/roundtables/${id})`;
const answered = { status: 'answered', threadId: 'thread-1', messageId: 'm-1', recipient: { agentId: 'reviewer', name: 'Nova Reed' }, reply: 'ok' };

test('an answered ask signs the turn with both FLAs and the conversation; the next turn starts empty', async () => {
  const app = application();
  const result = await withRoundtableReceipt(app, 'message_agent', { taskContextToken: 'turn-1' }, answered);
  assert.equal(result.reply, 'ok', 'the roundtable result is kept as it was');
  assert.equal(result.agent_receipt.markdown, `FULI Agents：${LEAD} & ${NOVA} · ${THREAD('thread-1')}`);
  assert.match(result.agent_receipt.guidance, /instead of the entry one/);
  assert.deepEqual(roundtableTurn('turn-1'), { threads: ['thread-1'], peers: [{ agentId: 'reviewer', name: 'Nova Reed' }] });
  // Another turn of the same session used no roundtable: nothing carries over.
  assert.equal(roundtableTurn('turn-2'), null);
});

test('a message still waiting links its conversation without naming the other FLA', async () => {
  const queued = await withRoundtableReceipt(application(), 'message_agent', { taskContextToken: 'turn-queued' },
    { ...answered, status: 'queued', threadId: 'thread-q' });
  assert.equal(queued.agent_receipt.markdown, `FULI Agent：${LEAD} · ${THREAD('thread-q')}`);
  // A stand-in answered for the other FLA: it took part.
  const stood = await withRoundtableReceipt(application(), 'message_agent', { taskContextToken: 'turn-stand-in' },
    { ...answered, status: 'stand_in', threadId: 'thread-s' });
  assert.equal(stood.agent_receipt.markdown, `FULI Agents：${LEAD} & ${NOVA} · ${THREAD('thread-s')}`);
});

test('the session that answers an ask names who asked, and two asks of one turn add up', async () => {
  const app = application();
  const replied = await withRoundtableReceipt(app, 'reply_agent_message', { taskContextToken: 'turn-reply' },
    { status: 'sent', threadId: 'thread-1', asker: { agentId: 'reviewer', name: 'Nova Reed' } });
  assert.equal(replied.agent_receipt.markdown, `FULI Agents：${LEAD} & ${NOVA} · ${THREAD('thread-1')}`);
  // The person asked (no asker), or the asker is this turn's own FLA: one name.
  const own = await withRoundtableReceipt(app, 'reply_agent_message', { taskContextToken: 'turn-own' },
    { status: 'sent', threadId: 'thread-9', asker: { agentId: 'lead', name: 'Alex Morgan' } });
  assert.equal(own.agent_receipt.markdown, `FULI Agent：${LEAD} · ${THREAD('thread-9')}`);
  await withRoundtableReceipt(app, 'message_agent', { taskContextToken: 'turn-two' }, answered);
  const second = await withRoundtableReceipt(app, 'message_agent', { taskContextToken: 'turn-two' },
    { ...answered, threadId: 'thread-2', recipient: { agentId: 'tester', name: 'Jamie Ash' } });
  assert.equal(second.agent_receipt.markdown, `FULI Agents：${LEAD} & ${NOVA} & [Jamie Ash](http://127.0.0.1:3999/agents/synthetic-space/tester)`
    + ` · ${THREAD('thread-1')} · [圆桌对话详情 2](http://127.0.0.1:3999/roundtables/thread-2)`);
});

test('a result without a thread, a task without an owner or a failed lookup leaves the result as it was', async () => {
  const plain = { status: 'validation' };
  assert.equal(await withRoundtableReceipt(application(), 'message_agent', { taskContextToken: 'turn-x' }, plain), plain);
  assert.equal(await withRoundtableReceipt(application(), 'message_agent', {}, answered), answered);
  assert.equal(await withRoundtableReceipt(application({ ownerless: true }), 'message_agent', { taskContextToken: 'turn-y' }, answered), answered);
  assert.equal(await withRoundtableReceipt(application({ registryFails: true }), 'message_agent', { taskContextToken: 'turn-z' }, answered), answered);
});

test('the first task of a new conversation keeps its habits line in the roundtable receipt; a later task never gains it', async () => {
  const app = { ...application(), recallImpressions: new RecallImpressionsStore(':memory:') };
  const habits = [{ id: 'pref-1', item_kind: 'entity' }];
  app.recallImpressions.recordDelivered({ taskContextToken: 'turn-first', personalSpaceId: 'synthetic-space',
    preferences: habits, opensConversation: true });
  app.recallImpressions.recordDelivered({ taskContextToken: 'turn-later', personalSpaceId: 'synthetic-space',
    preferences: habits, opensConversation: false });
  const first = await withRoundtableReceipt(app, 'message_agent', { taskContextToken: 'turn-first' }, answered);
  assert.equal(first.agent_receipt.markdown, `FULI Agents：${LEAD} & ${NOVA} · ${THREAD('thread-1')}\n`
    + `FULI 习惯：这个新对话带上了你的 1 条习惯 · [看看是哪几条](http://127.0.0.1:3999/habits/${taskKeyFor('turn-first').slice(0, 16)})`);
  const later = await withRoundtableReceipt(app, 'message_agent', { taskContextToken: 'turn-later' }, answered);
  assert.equal(later.agent_receipt.markdown, `FULI Agents：${LEAD} & ${NOVA} · ${THREAD('thread-1')}`);
});
