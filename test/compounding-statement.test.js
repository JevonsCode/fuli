import assert from 'node:assert/strict';
import test from 'node:test';

import { DelegatedOperationLog } from '../src/agent-delegation/operation-log.js';
import { handleStatementRequest } from '../src/http/statement-api-router.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { RecallImpressionsStore } from '../src/knowledge-impressions/store.js';
import { currentLocalWeek } from '../src/statement/compounding-statement.js';

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

async function call(app, search, remoteAddress = '127.0.0.1') {
  let status; let body;
  const response = { setHeader() {}, writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  const request = { method: 'GET', socket: { remoteAddress }, headers: { host: '127.0.0.1' } };
  const handled = await handleStatementRequest({ request, response, app,
    url: new URL(`http://127.0.0.1/api/statement?${new URLSearchParams(search)}`) });
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

test('the current local week runs Monday to Monday on this machine', () => {
  const { from, to } = currentLocalWeek(new Date(2026, 10, 13, 15, 30));
  assert.equal(new Date(from).getDay(), 1);
  assert.deepEqual([new Date(from).getDate(), new Date(from).getHours()], [9, 0]);
  assert.deepEqual([new Date(to).getDate(), new Date(to).getDay()], [16, 1]);
  // A Sunday belongs to the week that began six days before.
  assert.equal(new Date(currentLocalWeek(new Date(2026, 10, 15, 23, 0)).from).getDate(), 9);
});
