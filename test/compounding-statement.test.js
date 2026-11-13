import assert from 'node:assert/strict';
import test from 'node:test';

import { DelegatedOperationLog } from '../src/agent-delegation/operation-log.js';
import { callAgentTool } from '../src/agent-tools.js';
import { handleStatementRequest } from '../src/http/statement-api-router.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { RecallImpressionsStore } from '../src/knowledge-impressions/store.js';
import { currentLocalWeek } from '../src/statement/compounding-statement.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';

// The compounding statement over real local stores and a synthetic Provider.
// Synthetic spaces, ids and texts only; no FULI data directory is read.
const SPACE = 'synthetic-statement-space';
const HOUR = 60 * 60 * 1000;
// Judgment receipts are stamped with the real clock, so the window is around now.
const NOW = Date.now();
const FROM = new Date(NOW - 24 * HOUR).toISOString();
const TO = new Date(NOW + 24 * HOUR).toISOString();
const GRAPH = {
  series: [4, 6, 9],
  used: { times: 5, tasks: 3, cited: 2, applied: 3 },
  learned: { captured: 4, confirmed_by_you: 2, confirmed_by_tonborg: 1, promoted_by_use: 1, retired: 1 },
  done: { finished: 2, failed: 1 },
  answered: 3
};

function syntheticApp({ provider = async () => GRAPH, local = true } = {}) {
  const calls = [];
  const app = { config: { personal: { spaceId: SPACE } },
    personal: { readKnowledgeStatement: async input => { calls.push(input); return provider(input); } } };
  if (!local) return { app, calls };
  app.recallImpressions = new RecallImpressionsStore(':memory:', () => new Date(NOW - HOUR));
  app.recallImpressions.recordDelivered({ taskContextToken: 'fuli-task-synthetic-1', personalSpaceId: SPACE, sourceApplication: 'codex',
    facts: [{ id: 'rel-1' }], entities: [{ id: 'ent-1' }], preferences: [{ id: 'pref-1', item_kind: 'entity' }] });
  app.recallImpressions.recordDelivered({ taskContextToken: 'fuli-task-synthetic-2', personalSpaceId: SPACE, sourceApplication: 'claude-code',
    preferences: [{ id: 'pref-1', item_kind: 'entity' }] });
  const judgments = new JudgmentStore();
  const decide = key => judgments.record(SPACE, { kind: 'review', title: 'Synthetic review' }, key).id;
  const [kept, undone, failed] = [decide('kept'), decide('undone'), decide('failed')];
  judgments.execute(SPACE, kept, 'applied', { reason: 'Synthetic' });
  judgments.execute(SPACE, undone, 'applied', { reason: 'Synthetic' });
  judgments.execute(SPACE, undone, 'undone', { by: 'person' });
  judgments.execute(SPACE, failed, 'failed', { reason: 'Synthetic' });
  app.judgment = { store: () => judgments };
  app.delegatedOperations = new DelegatedOperationLog();
  const operation = (id, at, status) => app.delegatedOperations.record({ id, at, route: 'POST /api/synthetic', path: '/api/synthetic',
    category: 'organisation', actor: { agentId: 'synthetic-fla', projectId: null, client: 'codex', sessionId: 'synthetic-session' },
    reason: 'Synthetic', bodyFields: [], status, outcome: status < 400 ? 'succeeded' : 'failed', undo: 'Synthetic undo' });
  operation('in-window', new Date(NOW - HOUR).toISOString(), 200);
  operation('refused', new Date(NOW - HOUR).toISOString(), 403);
  operation('earlier', new Date(NOW - 48 * HOUR).toISOString(), 200);
  return { app, calls };
}

async function call(app, search, remoteAddress = '127.0.0.1', path = '/api/statement') {
  let status; let body;
  const response = { setHeader() {}, writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  const request = { method: 'GET', socket: { remoteAddress }, headers: { host: '127.0.0.1' } };
  const handled = await handleStatementRequest({ request, response, app,
    url: new URL(`http://127.0.0.1${path}?${new URLSearchParams(search)}`) });
  return { handled, status, body };
}

test('the statement answers every section from its own source, in the agreed shape', async () => {
  const { app, calls } = syntheticApp();
  const { status, body } = await call(app, { from: FROM, to: TO, weeks: '3' });
  assert.equal(status, 200);
  const week = 7 * 24 * HOUR;
  const points = [2, 1, 0].map(weeksBack => new Date(Date.parse(TO) - weeksBack * week).toISOString());
  assert.deepEqual(calls, [{ personal_space_id: SPACE, since: FROM, until: TO, points }]);
  assert.deepEqual(body, {
    window: { from: FROM, to: TO },
    total: { confirmed: 9 },
    series: points.map((to, index) => ({ to, confirmed: GRAPH.series[index] })),
    carried: { tasks: 2, clients: 2, items: 3 },
    used: { times: 5, tasks: 3, cited: 2, applied: 3 },
    learned: { captured: 4, confirmedByYou: 2, confirmedByTonborg: 1, promotedByUse: 1, retired: 1 },
    decided: { forYou: 2, undone: 1 },
    changed: { forYou: 1 },
    done: { finished: 2, failed: 1 },
    answered: { questions: 3 },
    unavailable: []
  });
});

test('a source that cannot be read leaves its sections out and is named; the route still answers', async () => {
  const down = syntheticApp({ provider: async () => { throw new Error('synthetic provider down'); } });
  const partial = await call(down.app, { from: FROM, to: TO });
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.body.unavailable, ['total', 'series', 'used', 'learned', 'done', 'answered']);
  assert.deepEqual(Object.keys(partial.body), ['window', 'carried', 'decided', 'changed', 'unavailable']);
  // Eight week-end points by default.
  const { app, calls } = syntheticApp({ local: false });
  const graphOnly = await call(app, { from: FROM, to: TO });
  assert.equal(calls[0].points.length, 8);
  assert.deepEqual(graphOnly.body.unavailable, ['carried', 'decided', 'changed']);
  assert.equal(graphOnly.body.series.length, 8);
});

test('the route reads only on this computer and refuses a window it cannot count', async () => {
  const { app, calls } = syntheticApp({ local: false });
  assert.equal((await call(app, { from: FROM, to: TO }, '192.0.2.10')).status, 403);
  for (const search of [{ to: TO }, { from: FROM }, { from: TO, to: FROM }, { from: '2026-11-09T00:00:00', to: TO },
    { from: 'last monday', to: TO }, { from: FROM, to: TO, weeks: '27' }, { from: FROM, to: TO, weeks: '0' },
    { from: FROM, to: TO, weeks: '2.5' }, { from: '2024-01-01T00:00:00Z', to: TO }]) {
    await assert.rejects(call(app, search), TypeError, JSON.stringify(search));
  }
  assert.deepEqual(calls, []);
});

test('read_compounding_statement answers this week by default, with one provenance line per section it has', async () => {
  const { app, calls } = syntheticApp({ provider: async () => { throw new Error('synthetic provider down'); } });
  const answer = await callAgentTool(app, 'read_compounding_statement', {});
  assert.deepEqual(answer.window, currentLocalWeek());
  assert.equal(calls[0].points.length, 8);
  assert.deepEqual(answer.unavailable, ['total', 'series', 'used', 'learned', 'done', 'answered']);
  assert.deepEqual(answer.provenance.map(line => line.split(':')[0]),
    ['carried.tasks, carried.clients, carried.items', 'decided.forYou, decided.undone', 'changed.forYou']);
  const full = await callAgentTool(syntheticApp().app, 'read_compounding_statement', { from: FROM, to: TO, weeks: 2 });
  assert.equal(full.series.length, 2);
  assert.ok(full.provenance.includes('used.times, used.tasks, used.cited, used.applied: reported, Agents\' own claims that knowledge mattered'));
  await assert.rejects(callAgentTool(app, 'read_compounding_statement', { from: FROM }), /from and to together/);
});

// The calendar's days: synthetic Provider days, local entries on both sides of a +08:00 midnight.
const DAYS_FROM = '2026-11-09T00:00:00+08:00';
const DAYS_TO = '2026-11-16T00:00:00+08:00';
function daysApp({ provider = async () => ({ days: [{ day: '2026-11-10', learned: 2, confirmed: 0, used: 1 },
  { day: '2026-11-12', learned: 0, confirmed: 1, used: 0 }] }) } = {}) {
  const calls = [];
  let clock = new Date('2026-11-10T15:30:00Z');
  const app = { config: { personal: { spaceId: SPACE } },
    personal: { readKnowledgeStatementDays: async input => { calls.push(input); return provider(input); } },
    recallImpressions: new RecallImpressionsStore(':memory:', () => clock) };
  const enter = (token, at) => {
    clock = new Date(at);
    app.recallImpressions.recordDelivered({ taskContextToken: token, personalSpaceId: SPACE, sourceApplication: 'codex',
      preferences: [{ id: 'pref-1', item_kind: 'entity' }] });
  };
  enter('fuli-task-synthetic-late', '2026-11-10T15:30:00Z'); // 23:30 on the 10th, local
  enter('fuli-task-synthetic-early', '2026-11-10T16:30:00Z'); // 00:30 on the 11th, local
  enter('fuli-task-synthetic-morning', '2026-11-11T01:00:00Z');
  enter('fuli-task-synthetic-after', '2026-11-16T00:30:00Z'); // after the range
  return { app, calls };
}

test('the statement by day cuts at the local midnight of the offset the caller sends', async () => {
  const { app, calls } = daysApp();
  const { status, body } = await call(app, { from: DAYS_FROM, to: DAYS_TO }, '127.0.0.1', '/api/statement/days');
  assert.equal(status, 200);
  assert.deepEqual(calls, [{ personal_space_id: SPACE, since: DAYS_FROM, until: DAYS_TO }]);
  assert.deepEqual(body, {
    window: { from: '2026-11-08T16:00:00.000Z', to: '2026-11-15T16:00:00.000Z' },
    days: [
      { day: '2026-11-10', learned: 2, confirmed: 0, used: 1, carried: 1 },
      { day: '2026-11-11', learned: 0, confirmed: 0, used: 0, carried: 2 },
      { day: '2026-11-12', learned: 0, confirmed: 1, used: 0, carried: 0 }
    ],
    unavailable: []
  });
  // In UTC the same entries fall on one day.
  const utc = await call(daysApp().app, { from: '2026-11-09T00:00:00Z', to: '2026-11-16T00:00:00Z' }, '127.0.0.1', '/api/statement/days');
  assert.deepEqual(utc.body.days.map(({ day, carried }) => [day, carried]), [['2026-11-10', 2], ['2026-11-11', 1], ['2026-11-12', 0]]);
});

test('the statement by day names a source it cannot read and leaves its measures out of every day', async () => {
  const { app } = daysApp({ provider: async () => { throw new Error('synthetic provider down'); } });
  const { body } = await call(app, { from: DAYS_FROM, to: DAYS_TO }, '127.0.0.1', '/api/statement/days');
  assert.deepEqual(body.unavailable, ['learned', 'confirmed', 'used']);
  assert.deepEqual(body.days, [{ day: '2026-11-10', carried: 1 }, { day: '2026-11-11', carried: 2 }]);
  const local = daysApp();
  delete local.app.recallImpressions;
  const graphOnly = await call(local.app, { from: DAYS_FROM, to: DAYS_TO }, '127.0.0.1', '/api/statement/days');
  assert.deepEqual(graphOnly.body.unavailable, ['carried']);
  assert.deepEqual(graphOnly.body.days.map(entry => Object.keys(entry)), [['day', 'learned', 'confirmed', 'used'], ['day', 'learned', 'confirmed', 'used']]);
});

test('the statement by day reads at most 371 days, one offset, only on this computer', async () => {
  const { app, calls } = daysApp();
  const days = (count) => new Date(Date.parse(DAYS_TO) - count * 24 * HOUR).toISOString().replace('Z', '+00:00');
  const year = await call(app, { from: days(371), to: '2026-11-15T16:00:00+00:00' }, '127.0.0.1', '/api/statement/days');
  assert.equal(year.status, 200);
  assert.equal((await call(app, { from: DAYS_FROM, to: DAYS_TO }, '192.0.2.10', '/api/statement/days')).status, 403);
  calls.length = 0;
  for (const search of [{ from: days(372), to: '2026-11-15T16:00:00+00:00' }, { from: DAYS_FROM, to: '2026-11-15T16:00:00Z' },
    { from: DAYS_TO, to: DAYS_FROM }, { from: '2026-11-09T00:00:00', to: DAYS_TO }, { to: DAYS_TO }]) {
    await assert.rejects(call(app, search, '127.0.0.1', '/api/statement/days'), TypeError, JSON.stringify(search));
  }
  assert.deepEqual(calls, []);
});

test('the current local week runs Monday to Monday on this machine', () => {
  const { from, to } = currentLocalWeek(new Date(2026, 10, 13, 15, 30));
  assert.equal(new Date(from).getDay(), 1);
  assert.deepEqual([new Date(from).getDate(), new Date(from).getHours()], [9, 0]);
  assert.deepEqual([new Date(to).getDate(), new Date(to).getDay()], [16, 1]);
  // A Sunday belongs to the week that began six days before.
  assert.equal(new Date(currentLocalWeek(new Date(2026, 10, 15, 23, 0)).from).getDate(), 9);
});

// Usage by client and model: task entries in the impressions store, answers of
// woken clients in a real roundtable store. Synthetic models and sessions only.
function usageApp({ wakes = true } = {}) {
  const at = new Date(NOW - HOUR);
  const app = { config: { personal: { spaceId: SPACE } }, recallImpressions: new RecallImpressionsStore(':memory:', () => at) };
  const enter = (token, sourceApplication, model) => app.recallImpressions.recordDelivered({ taskContextToken: token,
    personalSpaceId: SPACE, sourceApplication, model, preferences: [{ id: 'pref-1', item_kind: 'entity' }] });
  enter('fuli-task-usage-1', 'codex', 'synthetic-model-a');
  enter('fuli-task-usage-2', 'codex', 'synthetic-model-a');
  enter('fuli-task-usage-3', 'claude-code', null);
  if (!wakes) return app;
  const store = createRoundtableStore(':memory:', { clock: () => at });
  store.createThread({ id: 'thread-1', spaceId: SPACE, subject: 'Synthetic ask' });
  const reply = (id, via, client, model, usage) => store.appendMessage('thread-1', { id, kind: 'reply', body: 'ok', status: 'sent',
    via, from: { agentId: 'synthetic-fla', name: 'Synthetic', client, session: 'synthetic-session', model, usage } });
  reply('wake-1', 'claude_code:new', 'claude_code', 'synthetic-model-b', { inputTokens: 300, outputTokens: 20 });
  reply('wake-2', 'claude_code:resume', 'claude_code', null, null);
  reply('inbox-1', 'codex:inbox', 'codex', null, null);
  app.roundtable = { wakeUsage: ({ from, to }) => store.wakeUsageBetween(SPACE, from, to) };
  return app;
}

test('usage counts task entries and woken answers by client and model; unknown stays its own row, tokens only as reported', async () => {
  const { status, body } = await call(usageApp(), { from: FROM, to: TO }, '127.0.0.1', '/api/statement/usage');
  assert.equal(status, 200);
  assert.deepEqual(body, {
    window: { from: FROM, to: TO },
    rows: [
      { client: 'claude_code', model: null, taskEntries: 1, wakes: 1, tokens: null },
      { client: 'codex', model: 'synthetic-model-a', taskEntries: 2, wakes: 0, tokens: null },
      { client: 'claude_code', model: 'synthetic-model-b', taskEntries: 0, wakes: 1,
        tokens: { input: 300, output: 20, answers: 1, source: 'client_reported' } }
    ],
    more: false,
    unavailable: []
  });
  // Without a roundtable the wakes are named unavailable, never zeroed into the rows.
  const partial = await call(usageApp({ wakes: false }), { from: FROM, to: TO }, '127.0.0.1', '/api/statement/usage');
  assert.deepEqual(partial.body.unavailable, ['wakes']);
  assert.equal(partial.body.rows.length, 2);
  assert.equal((await call(usageApp(), { from: FROM, to: TO }, '192.0.2.10', '/api/statement/usage')).status, 403);
  await assert.rejects(call(usageApp(), { from: TO, to: FROM }, '127.0.0.1', '/api/statement/usage'), TypeError);
});

test('usage shows at most 20 rows and says there are more', async () => {
  const app = { config: { personal: { spaceId: SPACE } }, recallImpressions: new RecallImpressionsStore(':memory:', () => new Date(NOW - HOUR)) };
  for (let index = 0; index < 22; index += 1) {
    app.recallImpressions.recordDelivered({ taskContextToken: `fuli-task-many-${index}`, personalSpaceId: SPACE, sourceApplication: 'codex',
      model: `synthetic-model-${index}`, preferences: [{ id: 'pref-1', item_kind: 'entity' }] });
  }
  const { body } = await call(app, { from: FROM, to: TO }, '127.0.0.1', '/api/statement/usage');
  assert.equal(body.rows.length, 20);
  assert.equal(body.more, true);
});

test('read_compounding_statement adds usage with its provenance only when asked', async () => {
  const app = usageApp();
  app.personal = { readKnowledgeStatement: async () => GRAPH };
  const plain = await callAgentTool(app, 'read_compounding_statement', { from: FROM, to: TO });
  assert.equal('usage' in plain, false);
  assert.ok(!plain.provenance.some(line => line.startsWith('usage.')));
  const answer = await callAgentTool(app, 'read_compounding_statement', { from: FROM, to: TO, usage: true });
  assert.equal(answer.usage.rows.length, 3);
  assert.deepEqual(answer.provenance.filter(line => line.startsWith('usage.')).map(line => line.split(':')[0]),
    ['usage.rows[].taskEntries', 'usage.rows[].wakes', 'usage.rows[].model', 'usage.rows[].tokens']);
});
