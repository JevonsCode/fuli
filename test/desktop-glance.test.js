import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopGlance } from '../src/desktop-glance/glance.js';
import { handleDesktopGlanceRequest } from '../src/http/desktop-glance-api-router.js';

// Synthetic records only: no real space, assistant or thread.
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const SPACE = 'synthetic space';
const ago = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();
const worked = (agentId, hours, working = false) => ({ agent_id: agentId, last_active: ago(hours), working });
const thread = (id, hours, state = {}) =>
  ({ id, subject: `Subject of ${id}`, updatedAt: ago(hours), waiting: true, replying: false, waitingFor: [], ...state });

// `agents`: what the Provider answers, the latest first; `names`: the assistants that can be read.
function syntheticApp({ agents = [], threads = [], names = {} } = {}) {
  const asked = [];
  return {
    asked,
    config: { personal: { spaceId: SPACE } },
    personal: { recentWorkingAgents: async (input) => { asked.push(input); return agents; } },
    getProjectAgent: async ({ agentId }) => {
      if (!names[agentId]) throw new Error('synthetic: no such assistant');
      return { agentId, profile: names[agentId] };
    },
    roundtable: { threads: ({ limit }) => { asked.push({ threads: limit }); return { threads }; } }
  };
}

test('the glance names each assistant that began a task in the last day, the ones at work now first', async () => {
  const app = syntheticApp({
    agents: [worked('done-lead', 1), worked('busy/lead', 2, true), worked('gone-lead', 3), worked('late-lead', 20, true)],
    names: { 'done-lead': { name: 'Synthetic Done' }, 'busy/lead': { name: 'Stored name', displayName: 'Synthetic Busy' }, 'late-lead': { name: 'Synthetic Late' } }
  });
  const glance = await desktopGlance({ app, now: () => NOW });

  assert.deepEqual(glance.assistants.rows, [
    { name: 'Synthetic Busy', working: true, at: ago(2), link: 'fuli://agents/synthetic%20space/busy%2Flead' },
    { name: 'Synthetic Late', working: true, at: ago(20), link: 'fuli://agents/synthetic%20space/late-lead' },
    { name: 'Synthetic Done', working: false, at: ago(1), link: 'fuli://agents/synthetic%20space/done-lead' }
  ], 'the assistant that cannot be read has no row');
  assert.equal(glance.assistants.more, 0);
  assert.equal(glance.assistants.link, 'fuli://project-agents');
  assert.deepEqual(app.asked[0], { personalSpaceId: SPACE, since: ago(24) });
});

test('the glance holds five assistants and says how many more worked', async () => {
  const leads = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const app = syntheticApp({
    agents: leads.map((lead, index) => worked(lead, index + 1)),
    names: Object.fromEntries(leads.map((lead) => [lead, { name: `Synthetic ${lead}` }]))
  });
  const { assistants } = await desktopGlance({ app, now: () => NOW });
  assert.deepEqual(assistants.rows.map((row) => row.name), ['a', 'b', 'c', 'd', 'e'].map((lead) => `Synthetic ${lead}`));
  assert.equal(assistants.more, 2);
});

test('the glance lists roundtable threads with an ask still open that moved in the last day', async () => {
  const app = syntheticApp({ threads: [
    thread('answering', 1, { replying: true, waitingFor: ['Synthetic Reader'], subject: 'Two\nlines' }),
    thread('settled', 1, { waiting: false }),
    thread('stale', 30),
    thread('open/one', 2, { waitingFor: ['Synthetic A', 'Synthetic B'] }),
    thread('open-two', 3),
    thread('open-three', 4)
  ] });
  const { roundtables } = await desktopGlance({ app, now: () => NOW });
  assert.deepEqual(roundtables.rows, [
    { subject: 'Two lines', replying: true, waitingFor: ['Synthetic Reader'], link: 'fuli://roundtables/answering' },
    { subject: 'Subject of open/one', replying: false, waitingFor: ['Synthetic A', 'Synthetic B'], link: 'fuli://roundtables/open%2Fone' },
    { subject: 'Subject of open-two', replying: false, waitingFor: [], link: 'fuli://roundtables/open-two' }
  ]);
  assert.equal(roundtables.more, 1);
  assert.equal(roundtables.link, 'fuli://roundtables');
});

test('an assistant that cannot be read gives its row to the next one, and only the unread ones count as more', async () => {
  const leads = ['a', 'gone', 'b', 'c', 'd', 'e', 'f'];
  const app = syntheticApp({
    agents: leads.map((lead, index) => worked(lead, index + 1)),
    names: Object.fromEntries(leads.filter((lead) => lead !== 'gone').map((lead) => [lead, { name: `Synthetic ${lead}` }]))
  });
  const { assistants } = await desktopGlance({ app, now: () => NOW });
  assert.deepEqual(assistants.rows.map((row) => row.name), ['a', 'b', 'c', 'd', 'e'].map((lead) => `Synthetic ${lead}`));
  assert.equal(assistants.more, 1);
});

test('names and subjects reach the menu as one short readable line', async () => {
  const long = 'Synthetic'.repeat(10);
  const app = syntheticApp({
    agents: [worked('lead', 1, true)],
    names: { lead: { name: 'Synthetic\nLead\twith‮turned​text' } },
    threads: [thread('wide', 1, { subject: `Sub‮ject\nline`, waitingFor: [`${long}\n`, 'Synthetic B', 'Synthetic C', 'Synthetic D'] })]
  });
  const glance = await desktopGlance({ app, now: () => NOW });
  assert.equal(glance.assistants.rows[0].name, 'Synthetic Lead with turned text');
  const [row] = glance.roundtables.rows;
  assert.equal(row.subject, 'Sub ject line');
  assert.equal(row.waitingFor.length, 3);
  assert.ok(row.waitingFor[0].length <= 32 && row.waitingFor[0].endsWith('…'), row.waitingFor[0]);
  assert.deepEqual(row.waitingFor.slice(1), ['Synthetic B', '+2']);
});

test('a Provider that fails empties only the assistants; the roundtable still shows', async () => {
  const app = syntheticApp({ threads: [thread('open', 1)] });
  app.personal.recentWorkingAgents = async () => { throw new Error('synthetic: Provider down'); };
  const glance = await desktopGlance({ app, now: () => NOW });
  assert.deepEqual([glance.assistants.rows, glance.assistants.more], [[], 0]);
  assert.deepEqual(glance.roundtables.rows.map((row) => row.link), ['fuli://roundtables/open']);
});

test('a console without a personal space or a roundtable answers empty sections', async () => {
  const none = await desktopGlance({ app: { config: {} }, now: () => NOW });
  assert.deepEqual([none.assistants.rows, none.assistants.more, none.roundtables.rows], [[], 0, []]);
  const app = syntheticApp();
  delete app.roundtable;
  assert.deepEqual((await desktopGlance({ app, now: () => NOW })).roundtables.rows, []);
});

test('the glance route answers only a GET from this computer', async () => {
  const call = async ({ method = 'GET', remoteAddress = '127.0.0.1', path = '/api/desktop/glance' } = {}) => {
    let status; let body;
    const response = { setHeader() {}, writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
    const handled = await handleDesktopGlanceRequest({ request: { method, socket: { remoteAddress }, headers: { host: '127.0.0.1' } },
      response, url: new URL(`http://127.0.0.1${path}`), app: syntheticApp({ agents: [worked('lead', 1, true)], names: { lead: { name: 'Synthetic Lead' } } }) });
    return { handled, status, body };
  };
  const read = await call();
  assert.equal(read.status, 200);
  assert.equal(read.body.assistants.rows[0].name, 'Synthetic Lead');
  const remote = await call({ remoteAddress: '192.0.2.7' });
  assert.deepEqual([remote.status, remote.body.code], [403, 'local_user_only']);
  assert.equal((await call({ method: 'POST' })).status, 405);
  assert.equal((await call({ path: '/api/desktop/other' })).handled, false);
});
