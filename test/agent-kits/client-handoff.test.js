import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { clientHandoffs } from '../../packages/roundtable/src/roundtable/client-handoffs.js';
import { createRoundtableStore } from '../../packages/roundtable/src/roundtable/store.js';
import { clientHandoff, handoffWays, openTerminalHandoff } from '../../src/agent-kits/client-handoff.js';

const sender = { client: 'sample-client', sessionId: 'sender', agentId: 'sample-agent', projectId: 'sample' };

function setup(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'fuli-hand-off-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  const store = createRoundtableStore(':memory:', { clock: () => new Date(now) });
  t.after(() => store.close());
  const clock = () => now;
  const records = clientHandoffs({ store, now: clock, spaceId: () => 'space' });
  const app = { config: { personal: { spaceId: 'space' } }, roundtable: {
    clientHandoffs: records, knownProjectFolder: async () => dir } };
  const launched = [];
  const desktop = {
    async createInbox(options) {
      launched.push(options);
      options.delivery.started('recipient-session', { actualCwd: options.cwd, actualModel: options.model });
      options.delivery.saving();
      options.delivery.saved();
      launched.push({ threadId: 'recipient-session', message: options.delivery.message });
      return 'recipient-session';
    }
  };
  const system = {
    desktopSessionApp: id => id === 'codex' ? desktop : null,
    clientConnectionStatus: async () => ({ available: true, clients: [
      { id: 'codex', status: 'connected' }, { id: 'claude-code', status: 'connected' },
      { id: 'sample-prefill', status: 'connected' }, { id: 'removed', status: 'removed', previouslyConnected: true }
    ] }),
    newSessionWays: async ids => ({ ways: Object.fromEntries(ids.map(id => [id, { prompt: id === 'sample-prefill' ? 'prefill' : 'send' }])) }),
    async openNewSession(options) { launched.push(options); return { status: 'launch_requested' }; }
  };
  const act = (args, actor = sender) => clientHandoff(app, system, actor, args);
  const open = (extra = {}) => act({ action: 'open', client: 'codex', requestId: 'sample', projectPath: dir, prompt: 'Check the sample.', ...extra });
  return { app, store, records, dir, system, desktop, act, open, launched, next: () => { now += 60_001; } };
}

test('a permitted desktop handoff records the sender, exact target session, brief and verified read state', async t => {
  const f = setup(t);
  const [a, b] = await Promise.all([f.open({ model: 'sample-model' }), f.open({ model: 'sample-model' })]);
  assert.equal(a.handoffId, b.handoffId);
  assert.equal(f.launched.length, 2);
  const senderStatus = () => f.act({ action: 'status', handoffId: a.handoffId });
  assert.equal((await senderStatus()).status, 'sent');
  assert.equal((await senderStatus()).read, false);
  assert.equal(f.launched[0].cwd, f.dir);
  assert.equal(typeof f.launched[0].delivery.started, 'function');
  assert.equal(f.launched[0].model, 'sample-model');
  assert.equal(f.launched[1].threadId, 'recipient-session');
  assert.ok(f.launched[1].message.startsWith('Check the sample.'));
  const acknowledge = { action: 'acknowledge', handoffId: a.handoffId };
  await assert.rejects(f.act(acknowledge), { code: 'handoff_not_found' });
  await assert.rejects(f.act(acknowledge, { ...sender, client: 'codex' }), { code: 'handoff_not_found' });
  assert.equal((await f.act(acknowledge, { ...sender, client: 'codex', sessionId: 'recipient-session' })).read, true);
  const delivered = await senderStatus();
  assert.equal(delivered.read, true);
  assert.equal(delivered.wake, false);
  assert.equal(delivered.targetProjectId, sender.projectId);
  assert.equal(delivered.actualCwd, f.dir);
  assert.equal(delivered.actualModel, 'sample-model');
  assert.equal(delivered.requestedModel, 'sample-model');
  assert.equal(delivered.recipientAgentId, sender.agentId);
  assert.equal(delivered.sender.sessionId, sender.sessionId);
  await assert.rejects(f.act({ action: 'open', client: 'codex', projectPath: f.dir, requestId: 'another',
    prompt: 'Review the same sample.' }, { ...sender, client: 'codex', sessionId: 'recipient-session' }), { code: 'handoff_nested' });
  const [message] = f.store.messages(a.threadId);
  assert.equal(message.from_session, sender.sessionId);
  assert.equal(message.body, 'Check the sample.');
  assert.equal(message.to_client, 'codex');
  assert.equal(message.to_session, 'recipient-session');
  await assert.rejects(f.open({ prompt: 'Different task.' }), { code: 'handoff_conflict' });
  assert.equal(f.launched.length, 2);
});

test('only connected clients with a usable send method open, and CLI-only methods record the brief for an explicit launch', async t => {
  const f = setup(t);
  const ways = await handoffWays(f.system, sender, ['codex', 'claude-code', 'removed']);
  assert.deepEqual(Object.keys(ways.ways).sort(), ['claude-code', 'codex']);
  for (const client of ['removed', 'sample-prefill', 'unregistered']) {
    await assert.rejects(f.open({ client }), { code: 'handoff_unavailable' });
  }
  await assert.rejects(f.open({ client: 'claude-code', model: 'sample-model' }), { code: 'handoff_unavailable' });
  await assert.rejects(f.open({ prompt: 'x'.repeat(2001) }), { code: 'invalid_input' });
  await assert.rejects(f.open({ prompt: '\u0001' }), { code: 'invalid_input' });
  assert.equal(f.launched.length, 0);
  const receipt = await f.open({ client: 'claude-code', prompt: 'Check\u0007 the build.' });
  assert.equal(receipt.status, 'awaiting_user_launch');
  assert.equal(receipt.read, false);
  assert.deepEqual(f.launched, []);
  assert.equal(f.store.messages(receipt.threadId)[0].body, 'Check the build.');
  await assert.rejects(openTerminalHandoff(f.app, f.system, receipt.handoffId, () => { throw new Error('Permission off'); }), /Permission off/);
  assert.deepEqual(f.launched, []);
  await Promise.all([1, 2].map(() => openTerminalHandoff(f.app, f.system, receipt.handoffId, actor => assert.deepEqual(actor, sender))));
  assert.deepEqual(f.launched, [{ client: 'claude-code', workspacePath: f.dir, prompt: 'Check the build.' }]);
  assert.equal((await f.act({ action: 'status', handoffId: receipt.handoffId })).status, 'launch_requested');
});

test('an uncertain outcome is retained and the durable sender limit counts it once', async t => {
  const f = setup(t);
  f.desktop.createInbox = async options => {
    f.launched.push(options);
    options.delivery.started('recipient-session');
    options.delivery.saving();
    throw new Error('fixture disconnected');
  };
  assert.equal((await f.open()).status, 'unconfirmed');
  assert.equal((await f.open()).status, 'unconfirmed');
  assert.equal(f.launched.length, 1);
  for (const requestId of ['second', 'third']) await f.open({ requestId });
  await assert.rejects(f.open({ requestId: 'fourth' }), { code: 'handoff_rate_limited' });
  f.next();
  assert.equal((await f.open({ requestId: 'fourth' })).status, 'unconfirmed');
  assert.equal(f.launched.length, 4);
});

test('a slow desktop start returns a durable receipt before delivery completes', async t => {
  const f = setup(t);
  let finish;
  f.desktop.createInbox = options => new Promise(resolve => {
    finish = session => { options.delivery.started(session); f.launched.push(options); resolve(session); };
  });
  const keepAlive = setTimeout(() => {}, 3000);
  t.after(() => clearTimeout(keepAlive));
  const receipt = await f.open();
  assert.equal(receipt.status, 'opening');
  assert.equal((await f.open()).handoffId, receipt.handoffId);
  finish('recipient-session');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.act({ action: 'status', handoffId: receipt.handoffId })).status, 'sent');
  assert.equal(f.launched.length, 1);
});

test('a known refusal and a saved brief whose window failed have distinct receipts', async t => {
  const f = setup(t);
  f.desktop.createInbox = async options => {
    options.delivery.started('empty-session', { actualModel: null, actualCwd: null });
    throw Object.assign(new Error(), { code: 'handoff_permissions_unknown' });
  };
  const refused = await f.open();
  assert.equal(refused.status, 'refused');
  assert.equal(refused.delivery, 'not_saved');
  assert.equal(refused.sessionId, 'empty-session');
  assert.equal(refused.reason, 'handoff_permissions_unknown');
  await assert.rejects(f.act({ action: 'acknowledge', handoffId: refused.handoffId },
    { ...sender, client: 'codex', sessionId: 'empty-session' }), { code: 'handoff_not_found' });
  f.desktop.createInbox = async options => {
    options.delivery.started('saved-session', { actualModel: 'fixture', actualCwd: f.dir });
    options.delivery.saving();
    options.delivery.saved();
    throw new Error();
  };
  const saved = await f.open({ requestId: 'another' });
  assert.deepEqual([saved.status, saved.delivery, saved.nextTurn, saved.wake, saved.reason],
    ['sent', 'saved', true, false, 'client_window_unavailable']);
});
